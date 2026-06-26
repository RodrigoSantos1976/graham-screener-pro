/* ============================================================================
 * triagem_loader.js — Popula a Triagem direto do fundamentos.json + proxy.
 *
 * MUDANÇA-CHAVE (jun/2026): NÃO descarta mais empresas sem preço.
 *   carregarDaCVM()  -> mostra TODAS as elegíveis na hora (preço pendente).
 *   buscarMaisPrecos() -> busca preço de até PRECO_BATCH pendentes por clique
 *                         (maior VI primeiro), contornando o limite da brapi.
 *
 * Roda no MESMO escopo do screener (usa os globais já existentes:
 * DATA, enrich, onDataLoaded, renderAll, showTab e o PROXY_URL do index.html).
 * ========================================================================== */

const FUNDAMENTOS_URL = "data/fundamentos.json"; // gerado pela ingestão (Colab)
const PRECO_BATCH = 20;                          // brapi grátis: ~preços por clique

let _baseCVM = []; // base completa (todas as elegíveis) para fetch progressivo

/* Helper PURO (testável): combina fundamentos + preços.
 * IMPORTANTE: mantém TODAS as linhas — sem preço fica com p = NaN. */
function combinarFundamentosPrecos(base, precos) {
  return base.map((b) => {
    const px = precos[b.t] || {};
    const p = (px.preco != null) ? px.preco : NaN;
    return {
      t: b.t,
      p: p,
      lpa: b.lpa,
      vpa: b.vpa,
      liq: b.liq,
      pl: (!isNaN(p) && b.lpa > 0) ? p / b.lpa : NaN,
      pvp: (!isNaN(p) && b.vpa > 0) ? p / b.vpa : NaN,
      dy: (px.dy != null) ? px.dy : NaN,
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

    // 1) Base estática (lpa, vpa, liq) — todas com ticker e fórmula aplicável
    const respF = await fetch(FUNDAMENTOS_URL, { cache: "no-store" });
    if (!respF.ok) throw new Error("fundamentos.json não encontrado (" + respF.status + ")");
    const fund = await respF.json();
    _baseCVM = (fund.fundamentos || [])
      .filter((f) => f.ticker && f.lpa > 0 && f.vpa > 0)
      .map((f) => ({ t: f.ticker, lpa: f.lpa, vpa: f.vpa, liq: f.liq }));
    if (!_baseCVM.length) {
      throw new Error("Nenhuma empresa com ticker + LPA/VPA válidos. Confira o MAPA_TICKER na ingestão.");
    }

    // 2) Mostra TODAS imediatamente, sem preço (p = NaN)
    DATA = combinarFundamentosPrecos(_baseCVM, {}).map(enrich);
    window._fundAno = fund.ano || "?";
    onDataLoaded(`CVM — ${DATA.length} empresas elegíveis (ref. ${fund.ano || "?"}) · preços pendentes`);
    showTab("triagem", document.querySelectorAll(".nav button")[1]);

    // 3) Primeiro lote de preços (melhor esforço; maior VI primeiro)
    await buscarMaisPrecos(true);
  } catch (err) {
    _statusTri("err", "Erro: " + err.message);
  }
}

/* Busca preço de até PRECO_BATCH empresas ainda SEM preço (maior VI primeiro)
 * e faz merge no DATA, re-rodando o enrich() só nas linhas afetadas. */
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
      const p = (px.preco != null) ? px.preco : NaN;
      return enrich({
        t: d.t, p: p, lpa: d.lpa, vpa: d.vpa, liq: d.liq,
        pl: (!isNaN(p) && d.lpa > 0) ? p / d.lpa : NaN,
        pvp: (!isNaN(p) && d.vpa > 0) ? p / d.vpa : NaN,
        dy: (px.dy != null) ? px.dy : d.dy,
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
  module.exports = { combinarFundamentosPrecos };
}
