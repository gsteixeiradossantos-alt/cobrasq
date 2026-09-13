#!/usr/bin/env python3
"""
Importador dos Dados Públicos do CNPJ (Receita Federal) → Supabase COBRASQ.

Alimenta as tabelas rf_empresas / rf_estabelecimentos / rf_socios (migração
2026-07-27_rf_cnpj_socios.sql) para a consulta reversa "nome + 6 dígitos do CPF →
empresas" da tela de acordo — sem depender de API paga.

Uso:
    python3 import_cnpj_rf.py --uf PR,SC,RS
    python3 import_cnpj_rf.py --uf PR,SC,RS --skip-download   # reaproveita zips já baixados

Lê scripts/.env.local:
    DATABASE_URL   — string de conexão Postgres do Supabase (Session/Direct, porta 5432).
                     Ex.: postgresql://postgres:SENHA@db.<ref>.supabase.co:5432/postgres
    RF_MES         — pasta mensal do dump, formato AAAA-MM (ex.: 2026-07). Se ausente,
                     o script lista as pastas publicadas e pega a mais recente.
    RF_SHARE       — token do compartilhamento público (default YggdBLfdninEJX9).

Requisitos: `psql` no PATH (para o COPY). Só stdlib do Python.

Fonte (desde set/2026 a Receita serve o dump por um Nextcloud/SERPRO+, via WebDAV
público — a URL antiga /cnpj/dados_abertos_cnpj/ dá 404):
    https://arquivos.receitafederal.gov.br/index.php/s/YggdBLfdninEJX9
    WebDAV: https://arquivos.receitafederal.gov.br/public.php/webdav/<AAAA-MM>/<arquivo>.zip
            (HTTP Basic, usuário = token do share, senha vazia)
Layout dos arquivos: https://www.gov.br/receitafederal/dados/cnpj-metadados.pdf
Tamanho (2026-07): 37 zips, 7,6 GB — Estabelecimentos 5,3 GB, Empresas 1,4 GB, Sócios 0,7 GB.
As 10 partes de cada tabela são fatiadas por chaves DIFERENTES (a parte 9 de
Estabelecimentos não casa com a parte 9 de Sócios), por isso é preciso baixar tudo.

Colunas de contato/endereço (telefone, e-mail, logradouro, CEP…) entram desde a
migração 20260912_rf_cnpj_contato_endereco.sql — aplicar antes de rodar.
"""
from __future__ import annotations
import argparse, csv, io, os, ssl, subprocess, sys, urllib.request, urllib.error, urllib.parse, zipfile
from datetime import date
from pathlib import Path

csv.field_size_limit(10 * 1024 * 1024)

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

import base64
ROOT = Path(__file__).parent
ENV_FILE = ROOT / ".env.local"
HOST = "https://arquivos.receitafederal.gov.br"
SHARE = "YggdBLfdninEJX9"          # token do compartilhamento público dos Dados Abertos CNPJ
BASE = f"{HOST}/public.php/webdav"
# O servidor da RFB (gov.br atrás de WAF) devolve 403 para o User-Agent padrão do
# urllib. Nos passamos por um navegador em toda requisição.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def _req(url: str, method: str = "GET", extra: dict | None = None) -> urllib.request.Request:
    headers = {"User-Agent": UA, "Accept": "*/*"}
    # WebDAV público do Nextcloud: usuário = token do share, senha vazia.
    headers["Authorization"] = "Basic " + base64.b64encode(f"{SHARE}:".encode()).decode()
    if extra:
        headers.update(extra)
    return urllib.request.Request(url, method=method, headers=headers)

# Índices das colunas (arquivos SEM cabeçalho, ';'-separados, aspas '"', latin-1).
EST = dict(basico=0, ordem=1, dv=2, matriz=3, fantasia=4, situacao=5, dt_sit=6, motivo=7,
           dt_ini=10, cnae=11, tipo_log=13, log=14, num=15, compl=16, bairro=17, cep=18,
           uf=19, municipio=20, ddd1=21, tel1=22, ddd2=23, tel2=24, email=27)
EMP = dict(basico=0, razao=1, natureza=2, capital=4, porte=5)
SOC = dict(basico=0, ident=1, nome=2, doc=3, qualif=4, entrada=5)


def load_env() -> dict:
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def http_exists(url: str) -> bool:
    # Alguns espelhos da RFB recusam HEAD (403/405); nesse caso tenta um GET de 2 bytes.
    for method in ("HEAD", "GET"):
        req = _req(url, method, {"Range": "bytes=0-1"} if method == "GET" else None)
        try:
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=30) as r:
                if r.status in (200, 206):
                    return True
        except urllib.error.HTTPError as e:
            if e.code in (200, 206):
                return True
            continue  # HEAD 403/405 → tenta GET; GET com erro real → não existe
        except Exception:
            continue
    return False


def listar_webdav(caminho: str) -> list[str]:
    """PROPFIND Depth:1 numa pasta do share → nomes dos itens (sem a própria pasta)."""
    import re as _re
    req = _req(f"{BASE}/{caminho}".rstrip("/") + "/", "PROPFIND", {"Depth": "1"})
    with urllib.request.urlopen(req, context=SSL_CTX, timeout=60) as r:
        xml = r.read().decode("utf-8", "ignore")
    hrefs = _re.findall(r"<d:href>([^<]+)</d:href>", xml)
    nomes = [urllib.parse.unquote(h.rstrip("/").split("/")[-1]) for h in hrefs]
    return [n for n in nomes if n and n != caminho.rstrip("/").split("/")[-1] and n != "webdav"]


def descobrir_mes(env: dict) -> str:
    if env.get("RF_MES"):
        return env["RF_MES"]
    # As pastas do share são AAAA-MM (2023-05 … ); pega a mais recente que tenha Empresas0.
    try:
        meses = sorted(m for m in listar_webdav("") if len(m) == 7 and m[4] == "-")
    except Exception as e:
        print(f"❌ Não consegui listar as pastas do share ({e}). Defina RF_MES=AAAA-MM em .env.local.")
        sys.exit(1)
    for mes in reversed(meses):
        if http_exists(f"{BASE}/{mes}/Empresas0.zip"):
            return mes
    print("❌ Nenhuma pasta com Empresas0.zip. Defina RF_MES=AAAA-MM em .env.local.")
    sys.exit(1)


def baixar(url: str, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  · já existe: {dest.name}")
        return
    print(f"  ↓ {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(_req(url), context=SSL_CTX, timeout=120) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk); done += len(chunk)
            if total:
                sys.stdout.write(f"\r    {done*100//total}% ({done>>20} MB)")
                sys.stdout.flush()
    sys.stdout.write("\r" + " " * 40 + "\r")
    tmp.rename(dest)


def linhas_do_zip(zip_path: Path):
    """Gera as linhas (listas) do CSV único dentro do zip, em streaming."""
    with zipfile.ZipFile(zip_path) as z:
        nome = z.namelist()[0]
        with z.open(nome) as raw:
            txt = io.TextIOWrapper(raw, encoding="latin-1", newline="")
            yield from csv.reader(txt, delimiter=";", quotechar='"')


def _dig(s: str) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def processar(mes: str, ufs: set[str], work: Path, baixar_zips: bool):
    uf_label = ",".join(sorted(ufs))
    out_est = work / "rf_estabelecimentos.csv"
    out_emp = work / "rf_empresas.csv"
    out_soc = work / "rf_socios.csv"

    def grupo(prefixo: str):
        for i in range(10):
            nome = f"{prefixo}{i}.zip"
            dest = work / nome
            if baixar_zips:
                url = f"{BASE}/{mes}/{nome}"
                if not http_exists(url):
                    print(f"  · sem {nome} (ok, alguns meses têm menos partes)")
                    continue
                baixar(url, dest)
            if dest.exists():
                yield dest

    # ── Passo 1: Estabelecimentos → filtra UF, coleta os CNPJ básicos do estado ──
    print(f"\n[1/3] Estabelecimentos (filtrando UF={uf_label})…")
    pr_basicos: set[str] = set()
    n = 0
    with open(out_est, "w", newline="", encoding="utf-8") as fo:
        w = csv.writer(fo)
        for zp in grupo("Estabelecimentos"):
            print(f"  ⚙ {zp.name}")
            for row in linhas_do_zip(zp):
                if len(row) <= EST["municipio"]:
                    continue
                uf = (row[EST["uf"]] or "").strip().upper()
                if uf not in ufs:
                    continue
                bas = row[EST["basico"]].strip()
                pr_basicos.add(bas)
                g = lambda k: (row[EST[k]] if len(row) > EST[k] else "").strip()
                w.writerow([bas, g("ordem"), g("dv"), g("matriz"), g("fantasia"), g("situacao"), uf, g("municipio"),
                            g("dt_sit"), g("motivo"), g("dt_ini"), g("cnae"), g("tipo_log"), g("log"), g("num"),
                            g("compl"), g("bairro"), _dig(g("cep")),
                            _dig(g("ddd1") + g("tel1")), _dig(g("ddd2") + g("tel2")), g("email").lower()])
                n += 1
    print(f"  → {n} estabelecimentos, {len(pr_basicos)} CNPJs básicos em {uf_label}.")

    # ── Passo 2: Empresas (só os básicos do estado) ──
    print("\n[2/3] Empresas…")
    n = 0
    with open(out_emp, "w", newline="", encoding="utf-8") as fo:
        w = csv.writer(fo)
        for zp in grupo("Empresas"):
            print(f"  ⚙ {zp.name}")
            for row in linhas_do_zip(zp):
                if len(row) <= EMP["porte"]:
                    continue
                bas = row[EMP["basico"]].strip()
                if bas not in pr_basicos:
                    continue
                cap = (row[EMP["capital"]] or "0").strip().replace(".", "").replace(",", ".")
                try:
                    cap = float(cap)
                except ValueError:
                    cap = 0.0
                w.writerow([bas, row[EMP["razao"]].strip(), row[EMP["natureza"]].strip(),
                            row[EMP["porte"]].strip(), mes + "-01", cap])
                n += 1
    print(f"  → {n} empresas.")

    # ── Passo 3: Sócios (só os básicos do estado) ──
    print("\n[3/3] Sócios…")
    n = 0
    with open(out_soc, "w", newline="", encoding="utf-8") as fo:
        w = csv.writer(fo)
        for zp in grupo("Socios"):
            print(f"  ⚙ {zp.name}")
            for row in linhas_do_zip(zp):
                if len(row) <= SOC["entrada"]:
                    continue
                bas = row[SOC["basico"]].strip()
                if bas not in pr_basicos:
                    continue
                w.writerow([bas, row[SOC["ident"]].strip(), row[SOC["nome"]].strip(),
                            row[SOC["doc"]].strip(), row[SOC["qualif"]].strip(),
                            row[SOC["entrada"]].strip()])
                n += 1
    print(f"  → {n} sócios.")
    return out_emp, out_est, out_soc


def carregar(env: dict, out_emp: Path, out_est: Path, out_soc: Path):
    db = env.get("DATABASE_URL")
    if not db:
        print("\n⚠ DATABASE_URL ausente em .env.local — CSVs gerados, mas NÃO carregados.")
        print("  Rode manualmente no SQL Editor/psql:")
        print(f"    \\copy public.rf_empresas (cnpj_basico,razao_social,natureza_juridica,porte,atualizado_em,capital_social) from '{out_emp}' csv")
        print(f"    \\copy public.rf_estabelecimentos (cnpj_basico,cnpj_ordem,cnpj_dv,matriz_filial,nome_fantasia,situacao,uf,municipio,data_situacao,motivo_situacao,data_inicio,cnae,tipo_logradouro,logradouro,numero,complemento,bairro,cep,telefone1,telefone2,email) from '{out_est}' csv")
        print(f"    \\copy public.rf_socios (cnpj_basico,identificador,nome_socio,cnpj_cpf_socio,qualificacao,data_entrada) from '{out_soc}' csv")
        return
    # statement_timeout: o Supabase cancela comando longo por padrão ("canceling
    # statement due to statement timeout" — aconteceu em 12/09/2026 na linha 670 mil
    # de rf_empresas, com 12,8 M linhas para copiar). Zerar na sessão é permitido
    # para o role postgres e vale só para esta conexão.
    sql = f"""
\\set ON_ERROR_STOP on
set statement_timeout = 0;
set lock_timeout = 0;
set idle_in_transaction_session_timeout = 0;
begin;
truncate public.rf_socios, public.rf_estabelecimentos, public.rf_empresas;
\\copy public.rf_empresas (cnpj_basico,razao_social,natureza_juridica,porte,atualizado_em,capital_social) from '{out_emp}' csv
\\copy public.rf_estabelecimentos (cnpj_basico,cnpj_ordem,cnpj_dv,matriz_filial,nome_fantasia,situacao,uf,municipio,data_situacao,motivo_situacao,data_inicio,cnae,tipo_logradouro,logradouro,numero,complemento,bairro,cep,telefone1,telefone2,email) from '{out_est}' csv
\\copy public.rf_socios (cnpj_basico,identificador,nome_socio,cnpj_cpf_socio,qualificacao,data_entrada) from '{out_soc}' csv
commit;
"""
    print("\n⇪ Carregando no Supabase via psql…")
    p = subprocess.run(["psql", db], input=sql, text=True)
    if p.returncode != 0:
        print("❌ psql falhou — veja o erro acima."); sys.exit(1)
    print("✅ Carga concluída.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--uf", default="PR,SC,RS", help="UFs a carregar, separadas por vírgula (default PR,SC,RS). Uma rodada só: a carga faz TRUNCATE, então rodar por UF separada apagaria as outras.")
    ap.add_argument("--work-dir", default=str(ROOT / "_rf_cnpj"), help="Diretório de trabalho para os zips/CSVs")
    ap.add_argument("--skip-download", action="store_true", help="Não baixa; usa zips já presentes")
    args = ap.parse_args()

    env = load_env()
    global BASE, SHARE
    if env.get("RF_SHARE"):
        SHARE = env["RF_SHARE"].strip()
    if env.get("RF_BASE_URL"):
        BASE = env["RF_BASE_URL"].rstrip("/")
    ufs = {u.strip().upper() for u in args.uf.split(",") if u.strip()}
    uf = ",".join(sorted(ufs))
    work = Path(args.work_dir); work.mkdir(parents=True, exist_ok=True)
    mes = descobrir_mes(env)
    print(f"Dump RFB: {mes} · UF: {uf} · dir: {work}")

    out_emp, out_est, out_soc = processar(mes, ufs, work, baixar_zips=not args.skip_download)
    carregar(env, out_emp, out_est, out_soc)
    print("\nPronto. Reexecute mensalmente para atualizar (a carga faz TRUNCATE + reload).")


if __name__ == "__main__":
    main()
