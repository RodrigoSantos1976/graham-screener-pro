/* ============================================================================
 * brapi_proxy.js — Proxy de cotações da brapi (Cloudflare Worker).
 *
 * POR QUÊ: hoje o token está no HTML, visível em "ver código-fonte". Este
 * proxy guarda o token como SECRET no servidor; o navegador nunca o vê.
 * De quebra: agrupa tickers (conforme o plano), faz cache e controla o custo.
 *
 * ----------------------------------------------------------------------------
 * DEPLOY (gratuito):
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler secret put BRAPI_TOKEN      (cole o seu token)
 *   3. wrangler deploy
 *
 * wrangler.toml mínimo:
 *   name = "brapi-proxy"
 *   main = "brapi_proxy.js"
 *   compatibility_date = "2025-01-01"
 *   [vars]
 *   ALLOWED_ORIGIN = "https://rodrigosantos1976.github.io"
 *   CHUNK_SIZE = "1"     # plano gratuito: 1 ticker/req. Startup: 10. Pro: 20.
 *
 * USO no screener:
 *   fetch("https://brapi-proxy.SEU-SUBDOMINIO.workers.dev/?tickers=PETR4,BBAS3")
 *   → { quotes: [{ ticker, preco, variacaoPct, nome, atualizadoEm }], erros: [] }
 * ========================================================================== */

const DEFAULTS = {
  BRAPI_BASE: "https://brapi.dev/api/quote",
  CHUNK_SIZE: 1,     // tickers por requisição à brapi (depende do plano)
  MAX_TICKERS: 20,   // teto por chamada do cliente (trava abuso/custo)
  CACHE_TTL: 900,    // segundos de cache por ticker (15 min)
};

// PETR4, TAEE11, BPAC11... e índices como ^BVSP
function tickerValido(t) {
  return /^[A-Z]{4}\d{1,2}$/.test(t) || /^\^[A-Z]{3,4}$/.test(t);
}

function sanitizarTickers(raw, max) {
  const vistos = new Set();
  for (const t of String(raw || "").toUpperCase().split(",")) {
    const tt = t.trim();
    if (tickerValido(tt)) vistos.add(tt);
  }
  return [...vistos].slice(0, max);
}

function emPedacos(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function normalizar(r) {
  return {
    ticker: r.symbol,
    preco: r.regularMarketPrice ?? null,
    variacaoPct: r.regularMarketChangePercent ?? null,
    nome: r.longName || r.shortName || null,
    atualizadoEm: r.regularMarketTime || null,
  };
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origem = env.ALLOWED_ORIGIN || "*";
    const baseCors = cors(origem);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseCors });
    }
    if (request.method !== "GET") {
      return json({ erro: "Método não suportado." }, 405, baseCors);
    }

    const token = env.BRAPI_TOKEN;
    if (!token) {
      return json({ erro: "BRAPI_TOKEN não configurado no servidor." }, 500, baseCors);
    }

    const url = new URL(request.url);
    const tickers = sanitizarTickers(
      url.searchParams.get("tickers") || url.searchParams.get("ticker"),
      DEFAULTS.MAX_TICKERS
    );
    if (tickers.length === 0) {
      return json({ erro: "Nenhum ticker válido em ?tickers=" }, 400, baseCors);
    }

    const chunkSize = parseInt(env.CHUNK_SIZE, 10) || DEFAULTS.CHUNK_SIZE;
    const cache = caches.default;
    const quotes = [];
    const erros = [];
    const faltando = [];

    // 1) tenta o cache por ticker
    for (const t of tickers) {
      const chave = new Request(`https://cache.local/quote/${t}`);
      const hit = await cache.match(chave);
      if (hit) quotes.push(await hit.json());
      else faltando.push(t);
    }

    // 2) busca os que faltaram, em pedaços conforme o plano
    for (const grupo of emPedacos(faltando, chunkSize)) {
      const alvo = `${DEFAULTS.BRAPI_BASE}/${grupo.join(",")}?token=${encodeURIComponent(token)}`;
      try {
        const resp = await fetch(alvo, { cf: { cacheTtl: 0 } });
        if (!resp.ok) {
          erros.push({ tickers: grupo, status: resp.status });
          continue;
        }
        const dados = await resp.json();
        for (const r of dados.results || []) {
          const q = normalizar(r);
          quotes.push(q);
          // grava no cache por ticker
          const chave = new Request(`https://cache.local/quote/${q.ticker}`);
          const corpo = new Response(JSON.stringify(q), {
            headers: { "Cache-Control": `max-age=${DEFAULTS.CACHE_TTL}` },
          });
          ctx.waitUntil(cache.put(chave, corpo));
        }
      } catch (e) {
        erros.push({ tickers: grupo, erro: String(e) });
      }
    }

    return json({ quotes, erros, atualizadoEm: new Date().toISOString() }, 200, {
      ...baseCors,
      "Cache-Control": "no-store",
    });
  },
};

/* Exportações nomeadas dos helpers puros (para teste; o Worker usa o default). */
export { tickerValido, sanitizarTickers, emPedacos, normalizar, cors };
