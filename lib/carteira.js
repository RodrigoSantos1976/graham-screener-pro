/* ============================================================================
 * carteira.js — Derivação de métricas a partir do livro-razão de lançamentos.
 *
 * Princípio: NADA aqui é armazenado. Posição, preço médio, retornos e
 * proventos são sempre recalculados a partir dos lançamentos. Corrigiu um
 * lançamento? Tudo se reajusta sozinho.
 *
 * --------------------------------------------------------------------------
 * FORMATO DE UM LANÇAMENTO (uma linha do livro-razão):
 *   { tipo, ticker, data, quantidade, preco, taxas }
 *
 * Convenção (valor financeiro bruto = quantidade × preco):
 *   compra   → quantidade = nº de ações, preco = preço por ação.
 *              taxas entram no custo.
 *   venda    → quantidade = nº de ações, preco = preço por ação.
 *              taxas reduzem o valor recebido.
 *   provento → quantidade = nº de ações elegíveis, preco = provento por ação.
 *              taxas = retenção (ex.: IRRF sobre JCP). Total = qtd × preco − taxas.
 *   aporte   → ticker = null, quantidade = 1, preco = montante em R$.
 *   retirada → ticker = null, quantidade = 1, preco = montante em R$.
 *
 * Método de custo: PREÇO MÉDIO PONDERADO (padrão no Brasil). Em vendas
 * parciais o preço médio das ações remanescentes não muda.
 * ========================================================================== */

function _arred(x, casas = 2) {
  const f = Math.pow(10, casas);
  return Math.round((Number(x) || 0) * f) / f;
}

/**
 * @param {Array}  lancamentos   lista de lançamentos (ver formato acima)
 * @param {Object} precosAtuais  mapa { 'PETR4': 41.00, ... } p/ marcar a mercado
 * @returns {{ porTicker:Object, totais:Object, avisos:string[] }}
 */
function calcularCarteira(lancamentos, precosAtuais = {}) {
  // Processa em ordem cronológica (empates preservam a ordem de entrada).
  const eventos = [...lancamentos].sort(
    (a, b) => new Date(a.data).getTime() - new Date(b.data).getTime()
  );

  const porTicker = {};
  let realizadoTotal = 0;
  let proventosTotal = 0;
  let aportes = 0;
  let retiradas = 0;
  const avisos = [];

  const estado = (t) => {
    if (!porTicker[t]) {
      porTicker[t] = { quantidade: 0, precoMedio: 0, realizado: 0, proventos: 0 };
    }
    return porTicker[t];
  };

  for (const l of eventos) {
    const tipo = String(l.tipo || '').toLowerCase();
    const q = Number(l.quantidade) || 0;
    const p = Number(l.preco) || 0;
    const taxas = Number(l.taxas) || 0;
    const t = l.ticker;

    if (tipo === 'compra') {
      const s = estado(t);
      const custoCompra = q * p + taxas;                 // taxa entra no custo
      const novaQtd = s.quantidade + q;
      s.precoMedio = novaQtd > 0
        ? (s.quantidade * s.precoMedio + custoCompra) / novaQtd
        : 0;
      s.quantidade = novaQtd;

    } else if (tipo === 'venda') {
      const s = estado(t);
      let qVenda = q;
      if (qVenda > s.quantidade) {
        avisos.push(`Venda de ${qVenda} ${t} excede a posição de ${s.quantidade}; ajustada.`);
        qVenda = s.quantidade;
      }
      const recebido = qVenda * p - taxas;               // taxa reduz o recebido
      const custoBaixa = qVenda * s.precoMedio;          // baixa pelo preço médio
      const lucro = recebido - custoBaixa;
      s.realizado += lucro;
      realizadoTotal += lucro;
      s.quantidade -= qVenda;
      if (s.quantidade <= 0) { s.quantidade = 0; s.precoMedio = 0; }

    } else if (tipo === 'provento') {
      const s = estado(t);
      const valor = q * p - taxas;                       // líquido de retenção
      s.proventos += valor;
      proventosTotal += valor;

    } else if (tipo === 'aporte') {
      aportes += (q || 1) * p;                           // caixa: preco = montante

    } else if (tipo === 'retirada') {
      retiradas += (q || 1) * p;

    } else {
      avisos.push(`Tipo de lançamento desconhecido: "${l.tipo}".`);
    }
  }

  // ── Marcação a mercado das posições que PERMANECEM abertas ──
  let posicaoAtual = 0;
  let custoAberto = 0;
  let naoRealizadoTotal = 0;

  for (const t of Object.keys(porTicker)) {
    const s = porTicker[t];
    s.aberta = s.quantidade > 0;

    if (s.aberta) {
      const preco = precosAtuais[t];
      if (preco == null) {
        s.faltaPreco = true;
        s.valorMercado = null;
        s.naoRealizado = null;
        avisos.push(`Sem preço atual para ${t}; não-realizado não calculado.`);
      } else {
        s.faltaPreco = false;
        const custoPos = s.quantidade * s.precoMedio;
        s.valorMercado = s.quantidade * preco;
        s.naoRealizado = s.valorMercado - custoPos;
        posicaoAtual += s.valorMercado;
        custoAberto += custoPos;
        naoRealizadoTotal += s.naoRealizado;
      }
    } else {
      s.valorMercado = 0;
      s.naoRealizado = 0;
      s.faltaPreco = false;
    }

    // arredonda a saída por ticker
    s.precoMedio = _arred(s.precoMedio);
    s.realizado = _arred(s.realizado);
    s.proventos = _arred(s.proventos);
    if (s.valorMercado != null) s.valorMercado = _arred(s.valorMercado);
    if (s.naoRealizado != null) s.naoRealizado = _arred(s.naoRealizado);
  }

  const resultadoTotal = realizadoTotal + naoRealizadoTotal + proventosTotal;
  const retornoAbertasPct = custoAberto > 0
    ? _arred((naoRealizadoTotal / custoAberto) * 100)
    : null;

  return {
    porTicker,
    totais: {
      posicaoAtual: _arred(posicaoAtual),     // valor de mercado das abertas
      custoAberto: _arred(custoAberto),        // custo das que permanecem
      realizado: _arred(realizadoTotal),       // lucro/prejuízo já travado (vendas)
      naoRealizado: _arred(naoRealizadoTotal), // retorno SÓ das que permanecem (R$)
      retornoAbertasPct,                       // ...e em % sobre o custo aberto
      proventos: _arred(proventosTotal),       // renda recebida
      aportes: _arred(aportes),                // (alimenta o TWR/TIR depois)
      retiradas: _arred(retiradas),            // (idem)
      resultadoTotal: _arred(resultadoTotal),  // realizado + não-realizado + proventos
    },
    avisos,
  };
}

/* ============================================================================
 * EXEMPLO — rode para conferir (node carteira.js ou cole no console).
 * ========================================================================== */
if (typeof module !== 'undefined' && require.main === module) {
  const exemplo = [
    { tipo: 'aporte',   ticker: null,    data: '2025-01-02', quantidade: 1,   preco: 10000, taxas: 0 },
    { tipo: 'compra',   ticker: 'PETR4', data: '2025-01-05', quantidade: 100, preco: 35.00, taxas: 5 },
    { tipo: 'compra',   ticker: 'PETR4', data: '2025-03-10', quantidade: 50,  preco: 38.00, taxas: 3 },
    { tipo: 'provento', ticker: 'PETR4', data: '2025-04-20', quantidade: 150, preco: 1.20,  taxas: 0 },
    { tipo: 'venda',    ticker: 'PETR4', data: '2025-06-01', quantidade: 60,  preco: 40.00, taxas: 4 },
    { tipo: 'compra',   ticker: 'BBAS3', data: '2025-02-15', quantidade: 80,  preco: 28.00, taxas: 4 },
  ];
  const precos = { PETR4: 41.00, BBAS3: 26.50 };
  console.log(JSON.stringify(calcularCarteira(exemplo, precos), null, 2));
}

if (typeof module !== 'undefined') {
  module.exports = { calcularCarteira };
}
