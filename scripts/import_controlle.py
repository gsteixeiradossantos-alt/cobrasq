#!/usr/bin/env python3
"""
Importador one-shot Controlle → Supabase COBRASQ.
Uso: python3 import_controlle.py
Lê .env.local (CONTROLLE_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, START_DATE).
Idempotente: upsert por controlle_id.
"""
from __future__ import annotations
import json, os, ssl, sys, time, urllib.parse, urllib.request, urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

ROOT = Path(__file__).parent
ENV_FILE = ROOT / ".env.local"

def load_env():
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    # Aceita SUPABASE_SERVICE_KEY (nome das env vars da Vercel) como alias do _ROLE_.
    if not env.get("SUPABASE_SERVICE_ROLE_KEY") and env.get("SUPABASE_SERVICE_KEY"):
        env["SUPABASE_SERVICE_ROLE_KEY"] = env["SUPABASE_SERVICE_KEY"]
    for k in ("CONTROLLE_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not env.get(k):
            print(f"❌ Falta {k} em .env.local"); sys.exit(1)
    # Trata valor VAZIO (ex.: "END_DATE=" no .env) como ausente — não só chave faltando.
    if not env.get("START_DATE"):
        env["START_DATE"] = "2018-01-01"
    if not env.get("END_DATE"):
        env["END_DATE"] = date.today().isoformat()
    return env

ENV = load_env()
TOKEN = ENV["CONTROLLE_TOKEN"]
SB_URL = ENV["SUPABASE_URL"].rstrip("/")
SB_KEY = ENV["SUPABASE_SERVICE_ROLE_KEY"]
START_DATE = ENV["START_DATE"]
END_DATE = ENV["END_DATE"]
CTRL_BASE = "https://api-v1.controlle.com"

# ============================================================
# HTTP
# ============================================================

def http(url, method="GET", headers=None, body=None, timeout=60):
    headers = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")

def controlle_get(path, retry=3):
    url = path if path.startswith("http") else CTRL_BASE + path
    for i in range(retry):
        code, text = http(url, headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/json",
            "User-Agent": "curl/8.7.1",
        })
        if code == 429:
            print(f"  rate-limited, aguardando 30s ({i+1}/{retry})...")
            time.sleep(30); continue
        if code >= 400:
            raise RuntimeError(f"Controlle {code} em {url}: {text[:300]}")
        return json.loads(text)
    raise RuntimeError(f"Esgotaram {retry} tentativas em {url}")

def sb_request(method, path, body=None, params=None, prefer=None):
    qs = ("?" + urllib.parse.urlencode(params, doseq=True)) if params else ""
    url = f"{SB_URL}/rest/v1/{path}{qs}"
    headers = {
        "apikey": SB_KEY,
        "Authorization": f"Bearer {SB_KEY}",
        "Accept": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    code, text = http(url, method=method, headers=headers, body=body)
    if code >= 400:
        raise RuntimeError(f"Supabase {method} {path} → {code}: {text[:400]}")
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text

def sb_upsert(table, rows, on_conflict):
    """PostgREST upsert: POST com Prefer: resolution=merge-duplicates + ?on_conflict=<col>."""
    if not rows:
        return 0
    return sb_post_chunked(table, rows, params={"on_conflict": on_conflict},
                           prefer="resolution=merge-duplicates,return=minimal")

def sb_insert(table, rows):
    return sb_post_chunked(table, rows, prefer="return=minimal")

def sb_post_chunked(table, rows, params=None, prefer=None, chunk=500):
    n = 0
    for i in range(0, len(rows), chunk):
        batch = rows[i:i+chunk]
        sb_request("POST", table, body=batch, params=params, prefer=prefer)
        n += len(batch)
    return n

def sb_select(table, select="*", filters=None, order=None, limit=None):
    """filters: dict col → 'op.value' (ex: {'controlle_id': 'in.(1,2,3)'} ou {'controlle_id': 'eq.99'})."""
    params = {"select": select}
    if filters:
        for k, v in filters.items():
            params[k] = v
    if order:
        params["order"] = order
    if limit:
        params["limit"] = str(limit)
    return sb_request("GET", table, params=params)

def sb_update(table, patch, filters):
    params = dict(filters)
    return sb_request("PATCH", table, body=patch, params=params, prefer="return=minimal")

def sb_delete(table, filters):
    return sb_request("DELETE", table, params=filters, prefer="return=minimal")

def sb_id_map(table, controlle_field="controlle_id"):
    """Retorna dict controlle_id → id interno."""
    out = {}
    offset = 0
    page = 1000
    while True:
        rows = sb_request("GET", table,
                          params={"select": f"id,{controlle_field}", "limit": str(page), "offset": str(offset)})
        if not rows:
            break
        for r in rows:
            cid = r.get(controlle_field)
            if cid is not None:
                out[cid] = r["id"]
        if len(rows) < page:
            break
        offset += page
    return out

# ============================================================
# HELPERS
# ============================================================

def parse_date(v):
    if not v:
        return None
    return str(v)[:10]

def cents(v):
    if v is None:
        return None
    return float(v) / 100.0

def month_chunks(start, end, months=6):
    s = datetime.fromisoformat(start).date()
    e = datetime.fromisoformat(end).date()
    cur = s
    while cur <= e:
        # avança N meses
        y = cur.year + (cur.month - 1 + months) // 12
        m = (cur.month - 1 + months) % 12 + 1
        try:
            nxt = date(y, m, cur.day)
        except ValueError:
            # dia inexistente no mês alvo (ex: 31 → ajusta pro último)
            nxt = date(y, m, 28)
        win_end = min(nxt - timedelta(days=1), e)
        yield cur.isoformat(), win_end.isoformat()
        cur = nxt

# ============================================================
# LOADERS
# ============================================================

def load_categorias():
    print("→ Categorias...")
    j = controlle_get("/plan-account/v1/planAccountsEntities/")
    items = j.get("results", []) or []
    rows = [{
        "controlle_id": c["id"],
        "controlle_parent_id": c.get("id_plan_accounts_parent"),
        "descricao": c.get("ds_category") or "(sem descrição)",
        "nivel": c.get("level") or 1,
        "tipo_movimento": c.get("movement") or 0,
        "classificacao": c.get("classification"),
        "natureza": c.get("nature"),
        "cor": c.get("color"),
        "is_father": bool(c.get("is_father", False)),
        "ativa": (c.get("status", 1) == 1),
        "raw_payload": c,
    } for c in items]
    n = sb_upsert("fin_categoria", rows, "controlle_id")

    # 2º pass: parent_id interno
    m = sb_id_map("fin_categoria")
    for c in items:
        pid = c.get("id_plan_accounts_parent")
        if pid and pid in m and c["id"] in m:
            sb_update("fin_categoria", {"parent_id": m[pid]}, {"id": f"eq.{m[c['id']]}"})
    return n

def load_centros_custo():
    print("→ Centros de custo...")
    j = controlle_get("/cost-center/v1/costCenters/")
    items = j.get("results", []) or []
    rows = [{
        "controlle_id": c["id_cost_centers"],
        "controlle_parent_id": c.get("id_cost_centers_parent"),
        "descricao": c.get("ds_cost_center") or "(sem descrição)",
        "raw_payload": c,
    } for c in items]
    n = sb_upsert("fin_centro_custo", rows, "controlle_id")

    m = sb_id_map("fin_centro_custo")
    for c in items:
        pid = c.get("id_cost_centers_parent")
        if pid and pid in m and c["id_cost_centers"] in m:
            sb_update("fin_centro_custo", {"parent_id": m[pid]}, {"id": f"eq.{m[c['id_cost_centers']]}"})
    return n

def load_contas():
    print("→ Contas bancárias...")
    j = controlle_get("/account/v1/accounts/")
    items = j.get("results", []) or []
    rows = [{
        "controlle_id": c["id"],
        "descricao": c.get("ds_account") or "(sem descrição)",
        "banco_id": c.get("id_institution_financial"),
        "banco_nome": c.get("ds_institution_financial"),
        "agencia": c.get("agency_account"),
        "numero": c.get("number_account"),
        "tipo": c.get("type") or 0,
        "default_conta": bool(c.get("default", False)),
        "ativa": (c.get("status", 1) == 1),
        "saldo_inicial": cents(c.get("bank_balance")) or 0,
        "observacoes": c.get("obs_account"),
        "raw_payload": c,
    } for c in items]
    return sb_upsert("fin_conta", rows, "controlle_id")

def load_contatos():
    print("→ Contatos...")
    total = 0
    page = 1
    while True:
        j = controlle_get(f"/contact/v1/contacts/listContacts/?numberPage={page}")
        contacts = (j.get("results") or {}).get("contacts") or []
        if not contacts:
            break
        rows = [{
            "controlle_id": c["id_contact"],
            "nome": c.get("name") or "(sem nome)",
            "documento": c.get("document") or c.get("cpf_cnpj"),
            "email": c.get("email"),
            "telefone": c.get("phone"),
            "ativo": (c.get("situation", 1) == 1),
            "raw_payload": c,
        } for c in contacts]
        total += sb_upsert("fin_contato", rows, "controlle_id")
        if len(contacts) < 30:
            break
        page += 1
    return total

def load_lancamentos():
    print(f"→ Lançamentos ({START_DATE} → {END_DATE})...")
    conta_map = sb_id_map("fin_conta")
    contato_map = sb_id_map("fin_contato")
    categoria_map = sb_id_map("fin_categoria")
    cc_map = sb_id_map("fin_centro_custo")

    total = 0
    rateio_cat = 0
    rateio_cc = 0
    rec_ids = set()

    for win_start, win_end in month_chunks(START_DATE, END_DATE):
        page = 1
        while True:
            url = (f"/transaction/v1/transactions/list/?start_date={win_start}"
                   f"&end_date={win_end}&page={page}&orderBy=date&orderByCardinality=DESC")
            j = controlle_get(url)
            lst = (j.get("results") or {}).get("transactionsList") or []
            if not lst:
                break

            lanc_rows = []
            for t in lst:
                if t.get("id_transactions_recurrences"):
                    rec_ids.add(t["id_transactions_recurrences"])
                lanc_rows.append({
                    "controlle_payment_id": t.get("id_transactions_payments"),
                    "controlle_transaction_id": t.get("id_transactions"),
                    "controlle_recurrence_id": t.get("id_transactions_recurrences"),
                    "uuid": t.get("uuid_transactions_payments"),
                    "descricao": t.get("ds_transaction") or "(sem descrição)",
                    "data_competencia": parse_date(t.get("dt_competence")),
                    "data_vencimento": parse_date(t.get("dt_due")),
                    "data_pagamento": parse_date(t.get("dt_billing")),
                    "valor": cents(t.get("value_in_cent")) or 0,
                    "valor_pago": cents(t.get("payment_in_cent")),
                    "juros": cents(t.get("fees_in_cent")),
                    "multa": cents(t.get("fines_in_cent")),
                    "desconto": cents(t.get("discount_in_cent")),
                    "tipo_movimento": t.get("activity_type") or 0,
                    "status": t.get("situation") or 0,
                    "conta_id": conta_map.get(t.get("id_accounts_main")),
                    "contato_id": contato_map.get(t.get("id_contacts")),
                    "numero_parcela": t.get("repeat_index"),
                    "total_parcelas": t.get("repeat_total"),
                    "recorrencia_fixa": bool(t.get("recurrence_fixed", False)),
                    "conciliado": bool(t.get("is_conciled", False)),
                    "tem_rateio": bool(t.get("has_apportionment", False)),
                    "is_pagamento_parcial": bool(t.get("is_payment_partial", False)),
                    "observacoes": t.get("obs_transaction"),
                    "raw_payload": t,
                })

            sb_upsert("fin_lancamento", lanc_rows, "controlle_payment_id")
            total += len(lanc_rows)

            # Resolve IDs internos pra rateios
            payment_ids = [t["id_transactions_payments"] for t in lst if t.get("id_transactions_payments")]
            if payment_ids:
                # PostgREST: in.(v1,v2,...)
                in_clause = "in.(" + ",".join(str(x) for x in payment_ids) + ")"
                inserted = sb_select("fin_lancamento", "id,controlle_payment_id",
                                     {"controlle_payment_id": in_clause}, limit=len(payment_ids)+10)
                lanc_map = {r["controlle_payment_id"]: r["id"] for r in (inserted or [])}

                cats = []
                ccs = []
                for t in lst:
                    lid = lanc_map.get(t.get("id_transactions_payments"))
                    if not lid:
                        continue
                    for a in (t.get("apportionments_plan_account") or []):
                        cats.append({
                            "lancamento_id": lid,
                            "categoria_id": categoria_map.get(a.get("id_category")),
                            "controlle_apportionment_id": a.get("id"),
                            "controlle_categoria_id": a.get("id_category"),
                            "valor": cents(a.get("value")) or 0,
                        })
                    for a in (t.get("apportionments_cost_center") or []):
                        ccid = a.get("id_cost_center") or a.get("id_cost_centers")
                        ccs.append({
                            "lancamento_id": lid,
                            "centro_custo_id": cc_map.get(ccid),
                            "controlle_apportionment_id": a.get("id"),
                            "controlle_centro_custo_id": ccid,
                            "valor": cents(a.get("value")) or 0,
                        })

                if cats:
                    lids = list({c["lancamento_id"] for c in cats})
                    in_ids = "in.(" + ",".join(str(x) for x in lids) + ")"
                    sb_delete("fin_lancamento_categoria", {"lancamento_id": in_ids})
                    sb_insert("fin_lancamento_categoria", cats)
                    rateio_cat += len(cats)
                if ccs:
                    lids = list({c["lancamento_id"] for c in ccs})
                    in_ids = "in.(" + ",".join(str(x) for x in lids) + ")"
                    sb_delete("fin_lancamento_centro_custo", {"lancamento_id": in_ids})
                    sb_insert("fin_lancamento_centro_custo", ccs)
                    rateio_cc += len(ccs)

            print(f"  {win_start}..{win_end} pg{page}: +{len(lst)} lanç")
            if len(lst) < 100:
                break
            page += 1

    # Templates de recorrência sintéticos
    rec_count = 0
    for rid in rec_ids:
        sample = sb_select("fin_lancamento",
                           "descricao,valor,tipo_movimento,conta_id,contato_id,data_competencia",
                           {"controlle_recurrence_id": f"eq.{rid}"},
                           order="data_competencia.asc", limit=1)
        if not sample:
            continue
        s = sample[0]
        sb_upsert("fin_recorrencia_template", [{
            "controlle_id": rid,
            "descricao": s["descricao"],
            "valor": s["valor"],
            "tipo_movimento": s["tipo_movimento"],
            "conta_id": s["conta_id"],
            "contato_id": s["contato_id"],
            "data_inicio": s["data_competencia"],
        }], "controlle_id")
        rec_count += 1

    if rec_count:
        tpl_map = sb_id_map("fin_recorrencia_template")
        for rid, tpl_id in tpl_map.items():
            sb_update("fin_lancamento", {"recorrencia_template_id": tpl_id},
                      {"controlle_recurrence_id": f"eq.{rid}"})

    return {"lancamentos": total, "rateio_categoria": rateio_cat,
            "rateio_centro_custo": rateio_cc, "recorrencia_templates": rec_count}

# ============================================================
# MAIN
# ============================================================

def main():
    print("═" * 50)
    print("  Importação Controlle → Supabase COBRASQ")
    print(f"  Período: {START_DATE} → {END_DATE}")
    print("═" * 50)

    t0 = time.time()
    log_resp = sb_request("POST", "fin_sync_log", body={"notas": f"import desde {START_DATE}"},
                          prefer="return=representation")
    log_id = log_resp[0]["id"] if isinstance(log_resp, list) else log_resp["id"]
    totais = {}
    erros = []
    try:
        # Smoke test
        acc = controlle_get("/account/v1/accounts/")
        n_acc = len((acc or {}).get("results") or [])
        print(f"✓ Auth Controlle OK ({n_acc} contas)\n")

        totais["categorias"] = load_categorias()
        totais["centros_custo"] = load_centros_custo()
        totais["contas"] = load_contas()
        totais["contatos"] = load_contatos()
        totais.update(load_lancamentos())

        sb_update("fin_sync_log", {
            "finalizado_em": datetime.now(timezone.utc).isoformat(),
            "ok": True, "totais": totais, "erros": erros,
        }, {"id": f"eq.{log_id}"})

        elapsed = time.time() - t0
        print("\n" + "═" * 50)
        print("  ✅ Importação concluída")
        print("═" * 50)
        for k, v in totais.items():
            print(f"  {k:24s} {v}")
        print(f"  {'tempo':24s} {elapsed:.1f}s")
        print(f"  {'sync log id':24s} {log_id}")
    except Exception as e:
        import traceback
        erros.append({"message": str(e), "trace": traceback.format_exc()})
        try:
            sb_update("fin_sync_log", {
                "finalizado_em": datetime.now(timezone.utc).isoformat(),
                "ok": False, "totais": totais, "erros": erros,
            }, {"id": f"eq.{log_id}"})
        except Exception:
            pass
        print(f"\n❌ {e}")
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
