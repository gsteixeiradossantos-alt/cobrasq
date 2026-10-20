#!/usr/bin/env python3
"""Bancada de conferência do cliente — gera o seed SQL a partir do _bancada-dados.json.

Os dados (nomes de devedores, CPF, valores) NÃO entram no git: este script lê o JSON
na hora e grava, ao lado dele (ou em --saida):
  _bancada-seed.sql    → aplicar no SQL Editor DEPOIS da migração 20261019_bancada_conferencia
  _bancada-previa.txt  → exatamente o texto que o cliente verá no portal (para conferir)

Regras do texto ao cliente:
  - "NP" vira "Nota promissória"; "venc." vira "vencimento".
  - Cadastro ausente ("não cadastrada", "não cadastrada sob este cliente") vira
    "Ainda não consta no cadastro da COBRASQ." — sem revelar outro cliente.
  - Situação de devolução vira "Marcada para devolução".
  - Leitura incerta ("(?)" ou "provável") nunca aparece como fato: vira pergunta de
    confirmação, ou fica de fora se uma pergunta do item já trata daquele dado.
  - Chaves "nao_conferido": --nao-conferido=fora (padrão) ou =pergunta.
  - Telefone do credor, "origem", "aviso" e notas internas não saem.
  - O cliente é achado pelo nome EXATO em public.clientes; 0 ou 2+ → o seed para.

Uso:
  python3 scripts/bancada_seed.py "<pasta>/_bancada-dados.json" [--saida DIR] [--nao-conferido fora|pergunta]
"""
import argparse
import json
import os
import re
import sys

ROTULOS = {
    'cpf': 'CPF', 'endereco': 'Endereço', 'endereco_na_nota': 'Endereço',
    'telefone': 'Telefone', 'telefone_na_nota': 'Telefone', 'valor': 'Valor',
    'nome': 'Nome', 'trabalho': 'Local de trabalho', 'anotacao': 'Anotação',
    'status': 'Situação',
}
SEM_CADASTRO = 'Ainda não consta no cadastro da COBRASQ.'
# Palavras que não podem sair em texto da COBRASQ (skill compliance-cobrasq-advocacia).
# "ação" só como palavra inteira: "Situação", "Anotação" e "castração" não são ação judicial.
PROIBIDAS = re.compile(r'judicial|ajuiz|processo|\ba[çc][ãa]o\b|custas|honor|penhora|bloqueio|'
                       r'execu|advog|OAB|escrit[óo]rio|Teixeira|Azzolin', re.I)


def texto_cliente(s):
    s = re.sub(r'\bNP\b', 'Nota promissória', s)
    s = re.sub(r'\bvenc\.', 'vencimento', s)
    s = re.sub(r'\s*\(igual ao cadastro\)', '', s)
    return s.strip()


def incerto(v):
    return isinstance(v, str) and ('(?)' in v or 'provável' in v.lower())


def limpa_incerto(v):
    v = re.sub(r'\s*\((leitura )?provável[^)]*\)', '', v)
    return v.replace('(?)', '').strip()


def situacao(v):
    return 'Marcada para devolução' if re.search(r'devolv|devolu', v or '', re.I) else v


def rotulo(k):
    return ROTULOS.get(k, k.replace('_', ' ').capitalize())


def ja_perguntado(chave, perguntas):
    """Uma pergunta do item já trata deste dado? (telefone/CPF/endereço/nome/valor)"""
    alvo = {'telefone': 'telefone', 'cpf': 'cpf', 'endereco': 'endere', 'nome': 'nome',
            'valor': 'valor'}
    base = chave.replace('_na_nota', '')
    termo = alvo.get(base)
    return bool(termo) and any(termo in p.lower() for p in perguntas)


def monta_item(it, modo_nc, avisos):
    perguntas = [texto_cliente(p) for p in it.get('perguntas', [])]
    extras = []
    lido = []
    for k, v in (it.get('lido_na_nota') or {}).items():
        if k == 'nao_conferido' or k.endswith('_nao_conferido'):
            avisos.append(f"{it['devedor']}: campo não conferido '{k}' → {modo_nc}")
            if modo_nc == 'pergunta':
                extras.append(f'Na nota consta “{limpa_incerto(str(v))}”. Está certo?')
            continue
        if v is None:
            continue
        if incerto(v):
            if ja_perguntado(k, perguntas):
                avisos.append(f"{it['devedor']}: leitura incerta de {k} fora (já há pergunta)")
            else:
                avisos.append(f"{it['devedor']}: leitura incerta de {k} virou pergunta")
                extras.append(f'Na nota, o {rotulo(k).lower()} não ficou legível por inteiro; '
                              f'lemos “{limpa_incerto(v)}”. Está certo? Se não, qual é o correto?')
            continue
        lido.append({'rotulo': rotulo(k), 'valor': texto_cliente(str(v))})

    cad = it.get('cadastro')
    cadastro, nota = [], None
    if isinstance(cad, str):
        nota = SEM_CADASTRO if 'não cadastrad' in cad.lower() else texto_cliente(cad)
    elif isinstance(cad, dict):
        for k, v in cad.items():
            if k == 'nao_conferido' or incerto(v):
                avisos.append(f"{it['devedor']}: cadastro.{k} incerto/não conferido fora")
                continue
            valor = 'não consta' if v is None else (situacao(v) if k == 'status' else texto_cliente(str(v)))
            cadastro.append({'rotulo': rotulo(k), 'valor': valor})
    dados = {'lido': lido, 'cadastro': cadastro}
    if nota:
        dados['cadastro_nota'] = nota
    return {
        'arquivo': str(it['arquivo']), 'devedor': it['devedor'].strip(),
        'titulo': texto_cliente(it.get('titulo') or ''), 'dados': dados,
        'perguntas': perguntas + extras,
    }


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def gera(dados, modo_nc):
    avisos, credores = [], []
    for c in dados['credores']:
        itens = [monta_item(it, modo_nc, avisos) for it in c.get('itens', [])]
        credores.append({'nome': c['credor'], 'geral': c.get('pergunta_geral'), 'itens': itens})
    return credores, avisos


def sql(credores):
    out = ['-- Seed da bancada de conferência. Gerado por scripts/bancada_seed.py.',
           '-- Aplicar DEPOIS de 20261019_bancada_conferencia.sql. Idempotente: reaplicar',
           '-- atualiza item e pergunta, mas não troca o texto de pergunta já respondida.',
           'begin;']
    for c in credores:
        out.append('do $seed$ declare v_cli uuid; v_item uuid; begin')
        out.append(f"  select id into strict v_cli from public.clientes where nome = {q(c['nome'])};")
        if c['geral']:
            out.append('  insert into public.conferencia_perguntas(cliente_id, item_id, ordem, pergunta)')
            out.append(f"  values (v_cli, null, 1, {q(texto_cliente(c['geral']))})")
            out.append('  on conflict on constraint conferencia_perguntas_ordem_uk do update set pergunta = excluded.pergunta')
            out.append('   where public.conferencia_perguntas.resposta is null;')
        for n, it in enumerate(c['itens'], 1):
            dj = json.dumps(it['dados'], ensure_ascii=False)
            out.append('  insert into public.conferencia_itens(cliente_id, arquivo, devedor, titulo, ordem, dados)')
            out.append(f"  values (v_cli, {q(it['arquivo'])}, {q(it['devedor'])}, {q(it['titulo'])}, {n}, {q(dj)}::jsonb)")
            out.append('  on conflict (cliente_id, arquivo) do update set devedor = excluded.devedor,')
            out.append('    titulo = excluded.titulo, ordem = excluded.ordem, dados = excluded.dados, ativo = true')
            out.append('  returning id into v_item;')
            for o, p in enumerate(it['perguntas'], 1):
                out.append('  insert into public.conferencia_perguntas(cliente_id, item_id, ordem, pergunta)')
                out.append(f'  values (v_cli, v_item, {o}, {q(p)})')
                out.append('  on conflict on constraint conferencia_perguntas_ordem_uk do update set pergunta = excluded.pergunta')
                out.append('   where public.conferencia_perguntas.resposta is null;')
        out.append('end $seed$;')
    out.append('commit;')
    out.append('-- Conferência: itens e perguntas por cliente')
    out.append('select c.nome, (select count(*) from public.conferencia_itens i where i.cliente_id = c.id) itens,')
    out.append('       (select count(*) from public.conferencia_perguntas p where p.cliente_id = c.id) perguntas')
    out.append('  from public.clientes c where c.nome in (' + ', '.join(q(c['nome']) for c in credores) + ') order by 1;')
    return '\n'.join(out) + '\n'


def previa(credores):
    L = []
    for c in credores:
        L.append('=' * 72)
        L.append(f"CLIENTE: {c['nome']}  ({len(c['itens'])} título(s))")
        L.append('=' * 72)
        if c['geral']:
            L.append(f"Pergunta geral: {texto_cliente(c['geral'])}")
        for it in c['itens']:
            L.append('')
            L.append(f"■ {it['devedor']}")
            L.append(f"  Título: {it['titulo']}")
            if it['dados']['lido']:
                L.append('  Lido no título: ' + ' · '.join(f"{x['rotulo']}: {x['valor']}" for x in it['dados']['lido']))
            if it['dados']['cadastro']:
                L.append('  No cadastro da COBRASQ: ' + ' · '.join(f"{x['rotulo']}: {x['valor']}" for x in it['dados']['cadastro']))
            if it['dados'].get('cadastro_nota'):
                L.append('  ' + it['dados']['cadastro_nota'])
            for o, p in enumerate(it['perguntas'], 1):
                L.append(f'  {o}. {p}')
        L.append('')
    return '\n'.join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('json')
    ap.add_argument('--saida')
    ap.add_argument('--nao-conferido', choices=['fora', 'pergunta'], default='fora')
    a = ap.parse_args()
    with open(a.json, encoding='utf-8') as f:
        dados = json.load(f)
    credores, avisos = gera(dados, a.nao_conferido)
    txt = previa(credores)
    ruins = sorted({m.group(0) for m in PROIBIDAS.finditer(txt)})
    if ruins:
        print('ERRO: texto ao cliente contém palavra barrada pela compliance:', ', '.join(ruins), file=sys.stderr)
        sys.exit(2)
    saida = a.saida or os.path.dirname(os.path.abspath(a.json))
    with open(os.path.join(saida, '_bancada-seed.sql'), 'w', encoding='utf-8') as f:
        f.write(sql(credores))
    with open(os.path.join(saida, '_bancada-previa.txt'), 'w', encoding='utf-8') as f:
        f.write(txt)
    n_it = sum(len(c['itens']) for c in credores)
    n_pg = sum(len(it['perguntas']) for c in credores for it in c['itens']) + sum(1 for c in credores if c['geral'])
    print(f'{len(credores)} clientes, {n_it} itens, {n_pg} perguntas → {saida}')
    for x in avisos:
        print('  aviso:', x)


if __name__ == '__main__':
    main()
