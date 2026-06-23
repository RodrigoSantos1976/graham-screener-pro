/* ============================================================================
 * carteira_retornos.js — TWR (ponderado pelo tempo) e TIR / MWR (ponderado
 * pelo dinheiro) a partir da série de snapshots e dos fluxos de caixa.
 *
 * Par com carteira.js:
 *   - TWR  → mede a ESTRATÉGIA (neutraliza quando você aportou). Compare-o
 *            contra o IBOV e contra a carteira teórica de Graham.
 *   - TIR  → mede o SEU DINHEIRO (sensível ao timing dos aportes).
 *
 * --------------------------------------------------------------------------
 * ENTRADAS:
 *   snapshots: [{ data, valor }]  valor = valor de mercado TOTAL da carteira
 *                                 no fim daquele dia (posições + caixa).
 *   fluxos:    [{ data, tipo, valor }]  tipo = 'aporte' | 'retirada',
 *                                 valor positivo (montante em R$).
 *
 * Use extrairFluxos(lancamentos) para gerar `fluxos` a partir do livro-razão.
 * ========================================================================== */

function _arred(x, casas = 2) {
  const f = Math.pow(10, casas);
  return Math.round((Number(x) || 0) * f) / f;
}
function _dias(d1, d2) {
  return (new Date(d2) - new Date(d1)) / 86400000;
}

/** Extrai os fluxos de caixa (aportes/retiradas) de uma lista de lançamentos. */
function extrairFluxos(lancamentos) {
  return lancamentos
    .filter((l) => ['aporte', 'retirada'].includes(String(l.tipo).toLowerCase()))
    .map((l) => ({
      data: l.data,
      tipo: String(l.tipo).toLowerCase(),
      valor: (Number(l.quantidade) || 1) * (Number(l.preco) || 0),
    }));
}

/* ── TWR: encadeia os retornos dos subperíodos entre cada fluxo ───────────── */
function calcularTWR(snapshots, fluxos = []) {
  const snaps = [...snapshots].sort((a, b) => new Date(a.data) - new Date(b.data));
  if (snaps.length < 2) return null;

  // fluxo para DENTRO da carteira: aporte (+), retirada (−)
  const flows = fluxos.map((f) => ({
    data: f.data,
    valor: (String(f.tipo).toLowerCase() === 'retirada' ? -1 : 1) * (Number(f.valor) || 0),
  }));

  let fator = 1;
  const subperiodos = [];
  const avisos = [];

  for (let i = 1; i < snaps.length; i++) {
    const ini = snaps[i - 1];
    const fim = snaps[i];
    // fluxos ocorridos dentro do subperíodo, atribuídos ao início dele
    const F = flows
      .filter((f) => new Date(f.data) > new Date(ini.data) && new Date(f.data) <= new Date(fim.data))
      .reduce((s, f) => s + f.valor, 0);
    const base = ini.valor + F;
    if (base <= 0) {
      avisos.push(`Subperíodo ${ini.data}→${fim.data} ignorado (base não positiva).`);
      continue;
    }
    const r = fim.valor / base - 1;
    fator *= 1 + r;
    subperiodos.push({ de: ini.data, ate: fim.data, fluxo: _arred(F), retornoPct: _arred(r * 100, 4) });
  }

  const twr = fator - 1;
  const dias = _dias(snaps[0].data, snaps[snaps.length - 1].data);
  const twrAnual = dias > 0 ? Math.pow(1 + twr, 365 / dias) - 1 : null;

  return {
    twrPct: _arred(twr * 100),
    twrAnualPct: twrAnual == null ? null : _arred(twrAnual * 100),
    dias: Math.round(dias),
    subperiodos,
    avisos,
  };
}

/* ── TIR / MWR: TIR do fluxo de caixa do investidor (Actual/365) ──────────── */
function calcularTIR(snapshots, fluxos = []) {
  const snaps = [...snapshots].sort((a, b) => new Date(a.data) - new Date(b.data));
  if (snaps.length < 2) return null;

  const d0 = snaps[0].data;
  const v0 = Number(snaps[0].valor) || 0;
  const dN = snaps[snaps.length - 1].data;
  const vN = Number(snaps[snaps.length - 1].valor) || 0;

  // Perspectiva do investidor: dinheiro que SAI do bolso é negativo.
  const cf = [];
  if (v0 > 0) cf.push({ data: d0, valor: -v0 }); // investimento inicial
  for (const f of fluxos) {
    const sinal = String(f.tipo).toLowerCase() === 'retirada' ? +1 : -1; // aporte = −
    cf.push({ data: f.data, valor: sinal * (Number(f.valor) || 0) });
  }
  cf.push({ data: dN, valor: +vN }); // valor final = entrada virtual

  const npv = (r) =>
    cf.reduce((s, c) => s + c.valor / Math.pow(1 + r, _dias(d0, c.data) / 365), 0);

  // Bisecção robusta com expansão do limite superior.
  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  let fhi = npv(hi);
  let tent = 0;
  while (flo * fhi > 0 && tent < 80) {
    hi *= 1.5;
    fhi = npv(hi);
    tent++;
  }
  if (flo * fhi > 0) return { tirPct: null, aviso: 'Sem raiz única no intervalo (verifique os fluxos).' };

  let mid = lo;
  for (let i = 0; i < 200; i++) {
    mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7) break;
    if (flo * fm < 0) {
      hi = mid;
      fhi = fm;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return { tirPct: _arred(mid * 100) }; // taxa ANUAL (MWR)
}

/** Conveniência: devolve TWR e TIR juntos. */
function calcularRetornos(snapshots, fluxos = []) {
  return {
    twr: calcularTWR(snapshots, fluxos), // estratégia
    tir: calcularTIR(snapshots, fluxos), // seu dinheiro
  };
}

/* ============================================================================
 * EXEMPLO — rode para conferir (node carteira_retornos.js).
 * ========================================================================== */
if (typeof module !== 'undefined' && require.main === module) {
  const snapshots = [
    { data: '2025-01-01', valor: 1000 },
    { data: '2025-02-01', valor: 1100 },
    { data: '2025-03-01', valor: 1700 },
    { data: '2025-04-01', valor: 1600 },
  ];
  const fluxos = [
    { data: '2025-02-15', tipo: 'aporte', valor: 500 },
    { data: '2025-03-20', tipo: 'retirada', valor: 200 },
  ];
  console.log(JSON.stringify(calcularRetornos(snapshots, fluxos), null, 2));
}

if (typeof module !== 'undefined') {
  module.exports = { calcularTWR, calcularTIR, calcularRetornos, extrairFluxos };
}
