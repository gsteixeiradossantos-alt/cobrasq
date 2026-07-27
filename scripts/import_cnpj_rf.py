#!/usr/bin/env python3
"""
Importador dos Dados Públicos do CNPJ (Receita Federal) → Supabase COBRASQ.

Alimenta as tabelas rf_empresas / rf_estabelecimentos / rf_socios (migração
2026-07-27_rf_cnpj_socios.sql) para a consulta reversa "nome + 6 dígitos do CPF →
empresas" da tela de acordo — sem depender de API paga.

Uso:
    python3 import_cnpj_rf.py --uf PR
    python3 import_cnpj_rf.py --uf PR --skip-download   # reaproveita zips já baixados

Lê scripts/.env.local:
    DATABASE_URL   — string de conexão Postgres do Supabase (Session/Direct, porta 5432).
                     Ex.: postgresql://postgres:SENHA@db.<ref>.supabase.co:5432/postgres
    RF_MES         — pasta mensal do dump, formato AAAA-MM (ex.: 2026-06). Se ausente,
                     o script tenta os últimos meses automaticamente.

Requisitos: `psql` no PATH (para o COPY). Só stdlib do Python.

Fonte: https://arquivos.receitafederal.gov.br/dados/cnpj/dados_abertos_cnpj/
Layout dos arquivos: https://www.gov.br/receitafederal/dados/cnpj-metadados.pdf
"""
from __future__ import annotations
import argparse, csv, io, os, ssl, subprocess, sys, urllib.request, urllib.error, zipfile
from datetime import date
from pathlib import Path

csv.field_size_limit(10 * 1024 * 1024)

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

ROOT = Path(__file__).parent
ENV_FILE = ROOT / ".env.local"
BASE = "https://arquivos.receitafederal.gov.br/cnpj/dados_abertos_cnpj"
# O servidor da RFB (gov.br atrás de WAF) devolve 403 para o User-Agent padrão do
# urllib. Nos passamos por um navegador em toda requisição.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def _req(url: str, method: str = "GET", extra: dict | None = None) -> urllib.request.Request:
    headers = {"User-Agent": UA, "Accept": "*/*"}
    if extra:
        headers.update(extra)
    return urllib.request.Request(url, method=method, headers=headers)

# Índices das colunas (arquivos SEM cabeçalho, ';'-separados, aspas '"', latin-1).
EST = dict(basico=0, ordem=1, dv=2, matriz=3, fantasia=4, situacao=5, uf=19, municipio=20)
EMP = dict(basico=0, razao=1, natureza=2, porte=6)
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


def descobrir_mes(env: dict) -> str:
    if env.get("RF_MES"):
        return env["RF_MES"]
    # Tenta o mês atual e volta até 8 meses (a RFB publica com atraso). Sonda = Empresas0.
    y, m = date.today().year, date.today().month
    ultima_url = ""
    for _ in range(9):
        mes = f"{y:04d}-{m:02d}"
        ultima_url = f"{BASE}/{mes}/Empresas0.zip"
        if http_exists(ultima_url):
            return mes
        m -= 1
        if m == 0:
            m = 12; y -= 1
    print("❌ Não encontrei um mês publicado automaticamente.")
    print(f"   Última URL testada: {ultima_url}")
    print("   Defina RF_MES=AAAA-MM em .env.local (veja os meses em")
    print("   https://arquivos.receitafederal.gov.br/cnpj/dados_abertos_cnpj/ )")
    print("   ou ajuste RF_BASE_URL se a Receita mudou o caminho.")
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


def processar(mes: str, uf: str, work: Path, baixar_zips: bool):
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
    print(f"\n[1/3] Estabelecimentos (filtrando UF={uf})…")
    pr_basicos: set[str] = set()
    n = 0
    with open(out_est, "w", newline="", encoding="utf-8") as fo:
        w = csv.writer(fo)
        for zp in grupo("Estabelecimentos"):
            print(f"  ⚙ {zp.name}")
            for row in linhas_do_zip(zp):
                if len(row) <= EST["municipio"]:
                    continue
                if (row[EST["uf"]] or "").strip().upper() != uf:
                    continue
                bas = row[EST["basico"]].strip()
                pr_basicos.add(bas)
                w.writerow([bas, row[EST["ordem"]].strip(), row[EST["dv"]].strip(),
                            row[EST["matriz"]].strip(), row[EST["fantasia"]].strip(),
                            row[EST["situacao"]].strip(), uf, row[EST["municipio"]].strip()])
                n += 1
    print(f"  → {n} estabelecimentos, {len(pr_basicos)} CNPJs básicos em {uf}.")

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
                w.writerow([bas, row[EMP["razao"]].strip(), row[EMP["natureza"]].strip(),
                            row[EMP["porte"]].strip(), mes + "-01"])
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
        print(f"    \\copy public.rf_empresas (cnpj_basico,razao_social,natureza_juridica,porte,atualizado_em) from '{out_emp}' csv")
        print(f"    \\copy public.rf_estabelecimentos (cnpj_basico,cnpj_ordem,cnpj_dv,matriz_filial,nome_fantasia,situacao,uf,municipio) from '{out_est}' csv")
        print(f"    \\copy public.rf_socios (cnpj_basico,identificador,nome_socio,cnpj_cpf_socio,qualificacao,data_entrada) from '{out_soc}' csv")
        return
    sql = f"""
\\set ON_ERROR_STOP on
begin;
truncate public.rf_socios, public.rf_estabelecimentos, public.rf_empresas;
\\copy public.rf_empresas (cnpj_basico,razao_social,natureza_juridica,porte,atualizado_em) from '{out_emp}' csv
\\copy public.rf_estabelecimentos (cnpj_basico,cnpj_ordem,cnpj_dv,matriz_filial,nome_fantasia,situacao,uf,municipio) from '{out_est}' csv
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
    ap.add_argument("--uf", default="PR", help="UF a carregar (default PR)")
    ap.add_argument("--work-dir", default=str(ROOT / "_rf_cnpj"), help="Diretório de trabalho para os zips/CSVs")
    ap.add_argument("--skip-download", action="store_true", help="Não baixa; usa zips já presentes")
    args = ap.parse_args()

    env = load_env()
    global BASE
    if env.get("RF_BASE_URL"):
        BASE = env["RF_BASE_URL"].rstrip("/")
    uf = args.uf.strip().upper()
    work = Path(args.work_dir); work.mkdir(parents=True, exist_ok=True)
    mes = descobrir_mes(env)
    print(f"Dump RFB: {mes} · UF: {uf} · dir: {work}")

    out_emp, out_est, out_soc = processar(mes, uf, work, baixar_zips=not args.skip_download)
    carregar(env, out_emp, out_est, out_soc)
    print("\nPronto. Reexecute mensalmente para atualizar (a carga faz TRUNCATE + reload).")


if __name__ == "__main__":
    main()
