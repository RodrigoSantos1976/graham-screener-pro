#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mapa_ticker.py — Gera o de-para CD_CVM → [tickers] a partir do FCA da CVM.

Fonte: Formulário Cadastral (FCA), arquivo fca_cia_aberta_valor_mobiliario,
que lista os códigos de negociação (tickers) de cada companhia na B3,
já chaveados por Codigo_CVM. Ponte nativa — sem casar por nome.

    FCA → https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/FCA/DADOS/fca_cia_aberta_AAAA.zip

Saída: mapa_ticker.json  →  { "9512": ["PETR3","PETR4"], "906": ["BBAS3"], ... }

Como uma empresa tem várias classes (ON, PN, Units), o mapa é CD_CVM → LISTA.
Mantém só ações/units negociadas na B3, na versão cadastral mais recente.
"""

import io
import re
import sys
import json
import zipfile
import unicodedata

import requests
import pandas as pd

FCA_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/FCA/DADOS/fca_cia_aberta_{ano}.zip"
TICKER_RE = re.compile(r"^[A-Z]{4}\d{1,2}$")   # PETR4, TAEE11, BPAC11...


def _norm(s) -> str:
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode("ascii")
    return s.upper().strip()


def _ler_csv(zf, nome):
    with zf.open(nome) as fh:
        return pd.read_csv(fh, sep=";", encoding="latin-1", dtype=str)


def _achar_arquivo(nomes, *chaves):
    chaves = [_norm(k) for k in chaves]
    for n in nomes:
        if all(k in _norm(n) for k in chaves):
            return n
    return None


def _achar_coluna(df, *chaves):
    chaves = [_norm(k) for k in chaves]
    for c in df.columns:
        if all(k in _norm(c) for k in chaves):
            return c
    return None


def gerar_mapa(conteudo: bytes) -> dict:
    zf = zipfile.ZipFile(io.BytesIO(conteudo))
    arq = _achar_arquivo(zf.namelist(), "valor", "mobiliario")
    if not arq:
        raise FileNotFoundError("Arquivo fca_cia_aberta_valor_mobiliario não encontrado.")
    df = _ler_csv(zf, arq)

    col_cvm = _achar_coluna(df, "CVM")                        # Codigo_CVM
    col_tk = _achar_coluna(df, "NEGOCIACAO")                  # Codigo_Negociacao
    col_tipo = _achar_coluna(df, "VALOR", "MOBILIARIO")       # Valor_Mobiliario
    col_adm = _achar_coluna(df, "ENTIDADE", "ADMINISTRADORA") # Sigla_Entidade_Administradora
    col_data = _achar_coluna(df, "DATA", "REFER") or _achar_coluna(df, "REFER")
    if not col_cvm or not col_tk:
        raise KeyError(f"Colunas-chave não encontradas (cvm={col_cvm}, ticker={col_tk}).")

    df["_TK"] = df[col_tk].astype(str).str.strip().str.upper()
    m = df["_TK"].map(lambda t: bool(TICKER_RE.match(t)))      # só tickers de ação válidos
    if col_tipo:                                              # só ações/units
        m &= df[col_tipo].map(lambda x: "ACOES" in _norm(x) or "ACAO" in _norm(x) or "UNIT" in _norm(x))
    if col_adm:                                               # só B3
        m &= df[col_adm].map(lambda x: "B3" in _norm(x) or "BOVESPA" in _norm(x))
    dff = df[m].copy()

    # mantém apenas a versão cadastral mais recente por empresa
    if col_data:
        dff["_DT"] = pd.to_datetime(dff[col_data], errors="coerce", dayfirst=True)
        maxd = dff.groupby(col_cvm)["_DT"].transform("max")
        dff = dff[(dff["_DT"] == maxd) | dff["_DT"].isna()]

    mapa = {}
    for _, r in dff.iterrows():
        cd = str(r[col_cvm]).strip()
        if not cd.isdigit():
            continue
        mapa.setdefault(int(cd), set()).add(r["_TK"])
    return {k: sorted(v) for k, v in sorted(mapa.items())}


def baixar(ano: int) -> bytes:
    url = FCA_URL.format(ano=ano)
    print(f"Baixando {url} ...", file=sys.stderr)
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    return resp.content


def main(ano: int, saida: str = "mapa_ticker.json"):
    mapa = gerar_mapa(baixar(ano))
    with open(saida, "w", encoding="utf-8") as fh:
        json.dump({str(k): v for k, v in mapa.items()}, fh, ensure_ascii=False, indent=2)
    n_emp = len(mapa)
    n_tk = sum(len(v) for v in mapa.values())
    print(f"OK: {n_emp} empresas, {n_tk} tickers → {saida}", file=sys.stderr)


if __name__ == "__main__":
    ano = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    main(ano)
