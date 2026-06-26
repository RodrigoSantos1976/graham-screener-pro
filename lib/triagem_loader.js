/* ============================================================================
 * triagem_loader.js — Popula a Triagem direto do fundamentos.json + proxy.
 *
 * MUDANÇA-CHAVE (jun/2026):
 *   - NÃO descarta mais empresas sem preço (todas as elegíveis ficam visíveis).
 *   - num() normaliza TODO campo numérico: null/undefined/inválido -> NaN.
 *     (isNaN(null) === false faria um null escapar das guardas de render e
 *      quebrar no .toFixed(). Ex.: bancos com liq: null no fundamentos.json.)
 *   - carregarDaCVM(): mostra todas na hora; buscarMaisPrecos() preenche
 *     preços em lotes de PRECO_BATCH (maior VI primeiro).
 *
 * Roda no MESMO escopo do screener (globais já existentes: DATA, enrich,
 * onDataLoaded, renderAll, showTab e o PROXY_URL do index.html).
 * ========================================================================== */

const FUNDAMENTOS_URL = "data/fundamentos.json"; // gerado pela ingestão (Colab)
const PRECO_BATCH = 20;                          // brapi grátis: ~preços por clique

let _baseCVM = []; // base completa (todas as elegíveis) para fetch progressivo

/* Normaliza para número finito ou NaN — nunca null/undefined/string. */
function num(x) {
  if (x === null || x === undefined || x === "") return NaN;
  const n = Number(x);
  return isFinite(n) ? n : NaN;
}

/* Raiz do ticker: remove o dígito de classe no fim. CMIG4/CMIG3 -> "CMIG",
 * PETR3/PETR4 -> "PETR", SAPR11 -> "SAPR". Agrupa classes da mesma companhia. */
function rootTicker(t) {
  return String(t || "").replace(/\d+$/, "");
}

/* Deduplica por companhia: mantém UMA linha por raiz de ticker — a de maior
 * MoS. Sem preço (mos = NaN) conta como o menor possível, então some assim que
 * qualquer classe da empresa é precificada. */
function dedupePorEmpresa(rows) {
  const melhor = new Map();
  for (const d of rows) {
    const k = rootTicker(d.t);
    const prev = melhor.get(k);
    const m = isNaN(d.mos) ? -Infinity : d.mos;
    const pm = prev ? (isNaN(prev.mos) ? -Infinity : prev.mos) : -Infinity;
    if (!prev || m > pm) melhor.set(k, d);
  }
  return Array.from(melhor.values());
}

/* View usada pela Triagem e pela carteira automática: DATA deduplicado por
 * empresa. DATA continua completo para a precificação em lote. */
function vis() {
  return dedupePorEmpresa(typeof DATA !== "undefined" ? DATA : []);
}

/* Helper PURO (testável): combina fundamentos + preços.
 * IMPORTANTE: mantém TODAS as linhas — sem preço fica com p = NaN.
 * Garante que p, lpa, vpa, liq, pl, pvp, dy são SEMPRE number (ou NaN). */
function combinarFundamentosPrecos(base, precos) {
  return base.map((b) => {
    const px = precos[b.t] || {};
    const p = num(px.preco);
    const lpa = num(b.lpa), vpa = num(b.vpa), liq = num(b.liq);
    return {
      t: b.t,
      p: p,
      lpa: lpa,
      vpa: vpa,
      liq: liq,
      pl: (!isNaN(p) && lpa > 0) ? p / lpa : NaN,
      pvp: (!isNaN(p) && vpa > 0) ? p / vpa : NaN,
      dy: num(px.dy),
    };
  }); // sem .filter(): nenhuma empresa elegível é descartada
}

function _statusTri(cls, msg) {
  const bar = document.getElementById("import-log");
  const dot = document.getElementById("dot-s");
  const log = document.getElementById("log-msg");
  if (bar) { bar.style.display = "flex"; bar.className = "status-bar" + (cls ? " " + cls : ""); }
  if (dot) dot.className = "dot" + (cls === "err" ? " empty" : "");
  if (log) log.textContent = msg;
}

async function _fetchPrecos(tickers) {
  if (!tickers.length) return {};
  const resp = await fetch(`${PROXY_URL}/?tickers=${encodeURIComponent(tickers.join(","))}`);
  const dados = await resp.json();
  const precos = {};
  (dados.quotes || []).forEach((q) => { precos[q.ticker] = { preco: q.preco, dy: q.dy }; });
  return precos;
}

async function carregarDaCVM() {
  try {
    _statusTri("warn", "Carregando fundamentos da CVM...");

    const respF = await fetch(FUNDAMENTOS_URL, { cache: "no-store" });
    if (!respF.ok) throw new Error("fundamentos.json não encontrado (" + respF.status + ")");
    const fund = await respF.json();
    _baseCVM = (fund.fundamentos || [])
      .filter((f) => f.ticker && num(f.lpa) > 0 && num(f.vpa) > 0 && !isNaN(num(f.liq)))
      .map((f) => ({ t: f.ticker, lpa: num(f.lpa), vpa: num(f.vpa), liq: num(f.liq) }));
    if (!_baseCVM.length) {
      throw new Error("Nenhuma empresa com ticker + LPA/VPA válidos. Confira o MAPA_TICKER na ingestão.");
    }

    // Mostra TODAS imediatamente, sem preço (p = NaN)
    DATA = combinarFundamentosPrecos(_baseCVM, {}).map(enrich);
    window._fundAno = fund.ano || "?";
    onDataLoaded(`CVM — ${DATA.length} empresas elegíveis (ref. ${fund.ano || "?"}) · preços pendentes`);
    showTab("triagem", document.querySelectorAll(".nav button")[1]);

    // Primeiro lote de preços (melhor esforço; maior VI primeiro)
    await buscarMaisPrecos(true);
  } catch (err) {
    _statusTri("err", "Erro: " + err.message);
  }
}

/* Busca preço de até PRECO_BATCH empresas SEM preço (maior VI primeiro)
 * e faz merge no DATA, re-rodando enrich() só nas linhas afetadas. */
async function buscarMaisPrecos(silencioso) {
  if (!DATA.length) { if (!silencioso) alert("Carregue os dados da CVM primeiro."); return; }

  const pendentes = DATA
    .filter((d) => isNaN(d.p))
    .sort((a, b) => b.vi - a.vi)
    .slice(0, PRECO_BATCH)
    .map((d) => d.t);

  if (!pendentes.length) {
    _statusTri("", `Todas as ${DATA.length} empresas já têm preço.`);
    if (!silencioso) alert("Todas as empresas elegíveis já têm preço.");
    return;
  }

  try {
    _statusTri("warn", `Buscando preços de ${pendentes.length} ativos...`);
    const precos = await _fetchPrecos(pendentes);

    DATA = DATA.map((d) => {
      const px = precos[d.t];
      if (!px) return d;
      const p = num(px.preco);
      const dyNova = num(px.dy);
      return enrich({
        t: d.t, p: p, lpa: d.lpa, vpa: d.vpa, liq: d.liq,
        pl: (!isNaN(p) && d.lpa > 0) ? p / d.lpa : NaN,
        pvp: (!isNaN(p) && d.vpa > 0) ? p / d.vpa : NaN,
        dy: !isNaN(dyNova) ? dyNova : d.dy,
      });
    });

    const comPreco = DATA.filter((d) => !isNaN(d.p)).length;
    const semPreco = DATA.length - comPreco;
    onDataLoaded(
      `CVM — ${DATA.length} elegíveis · ${comPreco} com preço · ${semPreco} pendentes` +
      (window._fundAno ? ` (ref. ${window._fundAno})` : "")
    );
  } catch (err) {
    _statusTri("err", "Erro ao buscar preços: " + err.message);
  }
}

/* Export CJS só para teste em Node — inofensivo no navegador. */
if (typeof module !== "undefined") {
  module.exports = { combinarFundamentosPrecos, num, rootTicker, dedupePorEmpresa };
}
