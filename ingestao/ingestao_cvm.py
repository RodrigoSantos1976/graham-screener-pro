#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ingestao_cvm.py — Gera fundamentos.json a partir dos Dados Abertos da CVM.

Para cada companhia, calcula:
    VPA = Patrimônio Líquido / nº de ações
    LPA = Lucro Líquido       / nº de ações
    VI  = sqrt(22,5 × LPA × VPA)     (quando LPA e VPA > 0)

Fonte (pública, gratuita):
    DFP (anual) → https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_AAAA.zip

O de-para ticker é cruzado por CNPJ (mapa_ticker.json, gerado pelo mapa_ticker.py).
"""

import io
import os
import re
import sys
import json
import math
import zipfile
import unicodedata

import requests
import pandas as pd

DFP_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_{ano}.zip"

# De-para CNPJ(14 dígitos) → [tickers], gerado por mapa_ticker.py (mapa_ticker.json).
MAPA_TICKER_PATH = os.environ.get("MAPA_TICKER_PATH", "mapa_ticker.json")


def carregar_mapa_ticker(caminho=MAPA_TICKER_PATH):
    """Carrega o de-para CNPJ(14 dígitos) → [tickers]. Arquivo ausente → dict vazio."""
    try:
        with open(caminho, encoding="utf-8") as fh:
            bruto = json.load(fh)
        return {re.sub(r"\D", "", str(k)): list(v) for k, v in bruto.items()}
    except (FileNotFoundError, ValueError):
        return {}


MAPA_TICKER = carregar_mapa_ticker()


# ─────────────────────────── utilidades ────────────────────────────
def _norm(s) -> str:
    """Maiúsculas, sem acento — casa nomes de coluna/arquivo com robustez."""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode("ascii")
    return s.upper().strip()


def _num(serie: pd.Series) -> pd.Series:
    """Converte para float, tolerando vírgula (padrão CVM) ou ponto decimal."""
    s = serie.astype(str).str.strip()
    tem_virgula = s.str.contains(",", na=False)
    s = s.where(~tem_virgula,
                s.str.replace(".", "", regex=False).str.replace(",", ".", regex=False))
    return pd.to_numeric(s, errors="coerce")


def _ler_csv(zf: zipfile.ZipFile, nome: str) -> pd.DataFrame:
    with zf.open(nome) as fh:
        return pd.read_csv(fh, sep=";", encoding="latin-1", dtype=str)


def _achar_arquivo(nomes, *chaves):
    """Arquivo do ZIP cujo nome normalizado contém TODAS as chaves."""
    chaves = [_norm(k) for k in chaves]
    for n in nomes:
        nn = _norm(n)
        if all(k in nn for k in chaves):
            return n
    return None


def _achar_coluna(df, *chaves, excluir=()):
    """Coluna cujo nome normalizado contém todas as chaves e nenhuma de 'excluir'."""
    chaves = [_norm(k) for k in chaves]
    excluir = [_norm(e) for e in excluir]
    for c in df.columns:
        cn = _norm(c)
        if all(k in cn for k in chaves) and not any(e in cn for e in excluir):
            return c
    return None


def _aplicar_escala(df: pd.DataFrame) -> pd.Series:
    """ESCALA_MOEDA: 'MILHAR' multiplica VL_CONTA por 1000."""
    val = _num(df["VL_CONTA"])
    if "ESCALA_MOEDA" in df.columns:
        mult = df["ESCALA_MOEDA"].map(lambda x: 1000.0 if "MIL" in _norm(x) else 1.0)
        val = val * mult.values
    return val


def _ultimo_exercicio(df: pd.DataFrame) -> pd.DataFrame:
    """Mantém só o exercício corrente (ORDEM_EXERC = 'ÚLTIMO')."""
    if "ORDEM_EXERC" in df.columns:
        return df[df["ORDEM_EXERC"].map(lambda x: "LTIMO" in _norm(x))].copy()
    return df


# ─────────────────────── extração por demonstração ─────────────────
def patrimonio_liquido(zf, nomes) -> pd.DataFrame:
    """PL consolidado por CD_CVM, do BPP (Balanço Patrimonial Passivo)."""
    arq = _achar_arquivo(nomes, "BPP", "con")
    if not arq:
        raise FileNotFoundError("BPP consolidado não encontrado no ZIP.")
    df = _ultimo_exercicio(_ler_csv(zf, arq))
    df["VAL"] = _aplicar_escala(df)
    mask = df["CD_CONTA"].astype(str).str.strip().eq("2.03") | \
        df["DS_CONTA"].map(lambda x: "PATRIMONIO LIQUIDO" in _norm(x))
    return (df[mask].sort_values("CD_CONTA")
            .groupby("CD_CVM", as_index=False)
            .agg(DENOM_CIA=("DENOM_CIA", "first"),
                 CNPJ_CIA=("CNPJ_CIA", "first"),
                 DT_REFER=("DT_REFER", "first"),
                 PL=("VAL", "first")))


def lucro_liquido(zf, nomes) -> pd.DataFrame:
    """Lucro líquido consolidado por CD_CVM, da DRE."""
    arq = _achar_arquivo(nomes, "DRE", "con")
    if not arq:
        raise FileNotFoundError("DRE consolidada não encontrada no ZIP.")
    df = _ultimo_exercicio(_ler_csv(zf, arq))
    df["VAL"] = _aplicar_escala(df)
    mask = df["DS_CONTA"].map(
        lambda x: "LUCRO" in _norm(x) and "PERIODO" in _norm(x) and "ACAO" not in _norm(x))
    return (df[mask].groupby("CD_CVM", as_index=False).agg(LL=("VAL", "last")))


def numero_acoes(zf, nomes) -> pd.DataFrame:
    """nº de ações (ON + PN) por CD_CVM, da seção Composição do Capital."""
    arq = (_achar_arquivo(nomes, "composicao", "capital")
           or _achar_arquivo(nomes, "capital", "acao")
           or _achar_arquivo(nomes, "dados", "empresa"))
    if not arq:
        return pd.DataFrame(columns=["CD_CVM", "ACOES"])
    df = _ler_csv(zf, arq)
    col_on = _achar_coluna(df, "ORDINAR", excluir=("TESOURARIA",))
    col_pn = _achar_coluna(df, "PREFER", excluir=("TESOURARIA",))
    if not col_on and not col_pn:
        return pd.DataFrame(columns=["CD_CVM", "ACOES"])
    on = _num(df[col_on]).fillna(0) if col_on else 0
    pn = _num(df[col_pn]).fillna(0) if col_pn else 0
    df["ACOES"] = on + pn
    chave = "DT_REFER" if "DT_REFER" in df.columns else df.columns[0]
    return (df.sort_values(chave).groupby("CD_CVM", as_index=False)
            .agg(ACOES=("ACOES", "last")))


def _conta_consolidada(zf, nomes, arq_chaves, codigo, ds_chave) -> pd.DataFrame:
    """Valor de uma conta (CD_CONTA == codigo OU DS_CONTA contém ds_chave),
    do exercício corrente, consolidada, agregada por CD_CVM."""
    arq = _achar_arquivo(nomes, *arq_chaves)
    if not arq:
        return pd.DataFrame(columns=["CD_CVM", "VALOR"])
    df = _ultimo_exercicio(_ler_csv(zf, arq))
    df["VAL"] = _aplicar_escala(df)
    cod = df["CD_CONTA"].astype(str).str.strip().eq(codigo)
    desc = df["DS_CONTA"].map(lambda x: _norm(ds_chave) in _norm(x))
    return (df[cod | desc].sort_values("CD_CONTA")
            .groupby("CD_CVM", as_index=False).agg(VALOR=("VAL", "first")))


def ativo_circulante(zf, nomes) -> pd.DataFrame:
    """Ativo Circulante (BPA, conta 1.01) por CD_CVM."""
    return (_conta_consolidada(zf, nomes, ("BPA", "con"), "1.01", "Ativo Circulante")
            .rename(columns={"VALOR": "AC"}))


def passivo_circulante(zf, nomes) -> pd.DataFrame:
    """Passivo Circulante (BPP, conta 2.01) por CD_CVM."""
    return (_conta_consolidada(zf, nomes, ("BPP", "con"), "2.01", "Passivo Circulante")
            .rename(columns={"VALOR": "PC"}))


# ───────────────────────────── pipeline ────────────────────────────
def processar_zip(conteudo: bytes) -> list:
    zf = zipfile.ZipFile(io.BytesIO(conteudo))
    nomes = zf.namelist()

    base = (patrimonio_liquido(zf, nomes)
            .merge(lucro_liquido(zf, nomes), on="CD_CVM", how="left")
            .merge(numero_acoes(zf, nomes), on="CD_CVM", how="left")
            .merge(ativo_circulante(zf, nomes), on="CD_CVM", how="left")
            .merge(passivo_circulante(zf, nomes), on="CD_CVM", how="left"))

    registros = []
    for _, r in base.iterrows():
        cd_cvm = int(r["CD_CVM"]) if str(r["CD_CVM"]).isdigit() else r["CD_CVM"]
        acoes = r.get("ACOES")
        pl_v = r.get("PL")
        ll_v = r.get("LL")
        ac_v = r.get("AC")
        pc_v = r.get("PC")

        # Liquidez corrente = Ativo Circulante / Passivo Circulante (filtro da Triagem)
        liq = None
        if (ac_v is not None and not pd.isna(ac_v)
                and pc_v is not None and not pd.isna(pc_v) and pc_v != 0):
            liq = ac_v / pc_v

        lpa = vpa = vi = None
        elegivel, motivo = False, ""
        if acoes and not pd.isna(acoes) and acoes > 0:
            vpa = pl_v / acoes if pl_v is not None and not pd.isna(pl_v) else None
            lpa = ll_v / acoes if ll_v is not None and not pd.isna(ll_v) else None
            if lpa is not None and vpa is not None:
                if lpa > 0 and vpa > 0:
                    vi = math.sqrt(22.5 * lpa * vpa)
                    elegivel = True
                else:
                    motivo = "LPA ou VPA não positivo (fórmula não aplicável)"
            else:
                motivo = "faltam PL ou lucro"
        else:
            motivo = "nº de ações indisponível"

        # Cruza por CNPJ (14 dígitos). Uma linha por ticker (ON, PN, Unit
        # compartilham LPA/VPA; diferem só no preço/MoS). Sem ticker → linha nula.
        cnpj_chave = re.sub(r"\D", "", str(r.get("CNPJ_CIA") or ""))
        tickers = MAPA_TICKER.get(cnpj_chave) or [None]
        for tk in tickers:
            registros.append({
                "cd_cvm": cd_cvm,
                "ticker": tk,
                "empresa": (r.get("DENOM_CIA") or "").strip(),
                "cnpj": (r.get("CNPJ_CIA") or "").strip(),
                "data_ref": r.get("DT_REFER"),
                "pl": round(pl_v, 2) if pl_v is not None and not pd.isna(pl_v) else None,
                "lucro_liquido": round(ll_v, 2) if ll_v is not None and not pd.isna(ll_v) else None,
                "acoes": int(acoes) if acoes and not pd.isna(acoes) else None,
                "lpa": round(lpa, 4) if lpa is not None else None,
                "vpa": round(vpa, 4) if vpa is not None else None,
                "liq": round(liq, 2) if liq is not None else None,
                "vi": round(vi, 2) if vi is not None else None,
                "elegivel": elegivel,
                "motivo": motivo,
            })
    return registros


def baixar(ano: int) -> bytes:
    url = DFP_URL.format(ano=ano)
    print(f"Baixando {url} ...", file=sys.stderr)
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    return resp.content


def main(ano: int, saida: str = "fundamentos.json"):
    registros = processar_zip(baixar(ano))
    elegiveis = sum(1 for r in registros if r["elegivel"])
    payload = {
        "fonte": "CVM Dados Abertos — DFP",
        "ano": ano,
        "gerado_em": pd.Timestamp.utcnow().isoformat(),
        "total": len(registros),
        "elegiveis": elegiveis,
        "fundamentos": sorted(registros, key=lambda x: (x["vi"] is None, -(x["vi"] or 0))),
    }
    with open(saida, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(f"OK: {len(registros)} empresas ({elegiveis} elegíveis) → {saida}", file=sys.stderr)


if __name__ == "__main__":
    ano = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    main(ano)
