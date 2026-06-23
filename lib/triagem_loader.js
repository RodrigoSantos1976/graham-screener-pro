/* ============================================================================
 * triagem_loader.js — Popula a Triagem direto do fundamentos.json + proxy,
 * substituindo a importação de planilha.
 *
 * Roda no MESMO escopo do screener (usa os globais já existentes:
 * DATA, enrich, onDataLoaded, showTab e o PROXY_URL definido no buscarPrecos).
 * Inclua com <script src="lib/triagem_loader.js"></script> depois do script
 * principal, ou cole o conteúdo no bloco <script> existente.
 *
 * Campos da Triagem e suas origens:
 *   lpa, vpa, liq → fundamentos.json (CVM, trimestral)     [estático]
 *   p             → proxy/brapi (preço)                     [diário]
 *   pl = p/lpa, pvp = p/vpa → calculados na consulta
 *   dy            → proxy/brapi (se o proxy expuser o campo) [diário]
 * ========================================================================== */

const FUNDAMENTOS_URL = "data/fundamentos.json"; // gerado pelo job de ingestão

/* Helper PURO (testável): combina fundamentos + preços nas linhas da Triagem. */
function combinarFundamentosPrecos(base, precos) {
  return base.map((b) => {
    const px = precos[b.t] || {};
    const p = px.preco;
    return {
      t: b.t,
      p: p,
      lpa: b.lpa,
      vpa: b.vpa,
      liq: b.liq,
      pl: (p != null && b.lpa > 0) ? p / b.lpa : NaN,
      pvp: (p != null && b.vpa > 0) ? p / b.vpa : NaN,
      dy: (px.dy != null) ? px.dy : NaN,
    };
  }).filter((d) => d.t && !isNaN(d.p) && d.lpa > 0 && d.vpa > 0);
}

async function carregarDaCVM() {
  const bar = document.getElementById("import-log");
  const dot = document.getElementById("dot-s");
  const log = document.getElementById("log-msg");
  const status = (cls, msg) => {
    if (bar) { bar.style.display = "flex"; bar.className = "status-bar" + (cls ? " " + cls : ""); }
    if (dot) dot.className = "dot" + (cls === "err" ? " empty" : "");
    if (log) log.textContent = msg;
  };

  try {
    status("warn", "Carregando fundamentos da CVM...");

    // 1) Base estática (lpa, vpa, liq) — só empresas com ticker e fórmula aplicável
    const respF = await fetch(FUNDAMENTOS_URL, { cache: "no-store" });
    if (!respF.ok) throw new Error("fundamentos.json não encontrado (" + respF.status + ")");
    const fund = await respF.json();
    const base = (fund.fundamentos || [])
      .filter((f) => f.ticker && f.lpa > 0 && f.vpa > 0)
      .map((f) => ({ t: f.ticker, lpa: f.lpa, vpa: f.vpa, liq: f.liq }));
    if (!base.length) {
      throw new Error("Nenhuma empresa com ticker + LPA/VPA válidos. Preencha o MAPA_TICKER na ingestão.");
    }

    // 2) Preços (e DY, se o proxy fornecer) — o proxy agrupa e cacheia
    status("warn", `Buscando preços de ${base.length} ativos...`);
    const tickers = base.map((b) => b.t);
    const respP = await fetch(`${PROXY_URL}/?tickers=${encodeURIComponent(tickers.join(","))}`);
    const dadosP = await respP.json();
    const precos = {};
    (dadosP.quotes || []).forEach((q) => { precos[q.ticker] = { preco: q.preco, dy: q.dy }; });

    // 3) Combina e roda o enrich() que o screener já tem (calcula vi e mos)
    DATA = combinarFundamentosPrecos(base, precos).map(enrich);
    if (!DATA.length) throw new Error("Preços não retornaram. Confira o PROXY_URL.");

    const semPreco = base.length - DATA.length;
    onDataLoaded(
      `CVM + brapi — ${DATA.length} ativos (ref. ${fund.ano || "?"})` +
      (semPreco > 0 ? ` · ${semPreco} sem preço` : "")
    );
    showTab("triagem", document.querySelectorAll(".nav button")[1]);
  } catch (err) {
    status("err", "Erro: " + err.message);
  }
}

/* Export CJS só para teste em Node — inofensivo no navegador (module é undefined). */
if (typeof module !== "undefined") {
  module.exports = { combinarFundamentosPrecos };
}
