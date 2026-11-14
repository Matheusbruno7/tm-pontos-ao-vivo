// CASQUINHA · pontos ao vivo
// Worker (API pública) + Durable Object "Estado" (coleta a cada minuto e guarda os dados).
import { DurableObject } from "cloudflare:workers";
import { calcularTudo, identidade, normalizar, pesoDoEvento } from "./calculo.js";

const CBTM = "https://live.cbtm.org.br/api/local/";
const UA = "casquinha-ao-vivo/1.0 (pontos de rating; consulta a cada minuto durante eventos)";
const VERSAO = "7"; // aumente quando mudar a regra de cálculo
const MAX_CONSULTAS_POR_RODADA = 12;
const CATALOGO_A_CADA_MIN = 30;

// hash FNV-1a de 32 bits, para detectar mudanças
function hash(texto) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

const json = (dados, status = 200, cache = 30) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${cache}`,
    },
  });

async function cbtm(caminho) {
  const r = await fetch(CBTM + caminho, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error(`CBTM ${r.status} em ${caminho}`);
  return r.json();
}

// Guarda só o que o cálculo e o site usam (a resposta original é grande).
function enxugar(c) {
  return {
    entries: (c.entries || []).filter((e) => e.kind === "individual").map((e) => ({
      kind: e.kind,
      members: (e.members || []).map((m) => ({ key: m.key, name: m.name, club: m.club, rating: m.rating })),
    })),
    // jogos finalizados + jogos ainda por acontecer com os dois atletas já definidos
    games: (c.games || []).filter((g) => g.finished || (!g.wo && g.first?.key && g.second?.key)).map((g) => ({
      key: g.key, number: g.number, day: g.day, time: g.time, finished: g.finished, wo: g.wo,
      category: g.category, phase: g.phase, group: g.group, table: g.table, sets: g.sets,
      first: { key: g.first?.key, name: g.first?.name, club: g.first?.club, won: g.first?.won, score: g.first?.score },
      second: { key: g.second?.key, name: g.second?.name, club: g.second?.club, won: g.second?.won, score: g.second?.score },
    })),
    resumo: c.summary || null,
  };
}

export class Estado extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS eventos (
      slug TEXT PRIMARY KEY, nome TEXT, inicio TEXT, fim TEXT, formato TEXT, cidade TEXT, uf TEXT,
      peso INTEGER, tipo TEXT, estimado INTEGER, fase TEXT, consulta TEXT, assinatura TEXT,
      consultado_em INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS saida (chave TEXT PRIMARY KEY, valor TEXT, h TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT)`);
  }

  cfg(chave, padrao = null) {
    const r = this.sql.exec("SELECT valor FROM config WHERE chave = ?", chave).toArray()[0];
    return r ? r.valor : padrao;
  }
  setCfg(chave, valor) {
    this.sql.exec("INSERT OR REPLACE INTO config (chave, valor) VALUES (?, ?)", chave, String(valor));
  }
  saida(chave) {
    const r = this.sql.exec("SELECT valor FROM saida WHERE chave = ?", chave).toArray()[0];
    return r ? JSON.parse(r.valor) : null;
  }
  setSaida(chave, valor) {
    // grava só se mudou (o plano grátis limita as gravações por dia)
    const texto = JSON.stringify(valor);
    const h = hash(texto);
    const atual = this.sql.exec("SELECT h FROM saida WHERE chave = ?", chave).toArray()[0];
    if (atual && atual.h === h) return;
    this.sql.exec("INSERT OR REPLACE INTO saida (chave, valor, h) VALUES (?, ?, ?)", chave, texto, h);
  }

  oficialAte() {
    return this.cfg("oficial_ate", this.env.OFICIAL_ATE || "2026-09-27");
  }

  async atualizarOficialAte() {
    // O tm-clubes publica toda segunda até que data o rating oficial já inclui os jogos.
    const ultima = +this.cfg("oficial_checado_em", 0);
    if (Date.now() - ultima < 6 * 3600e3) return;
    this.setCfg("oficial_checado_em", Date.now());
    try {
      const r = await fetch(this.env.HUB_DADOS + "ranking_clubes.json", { cf: { cacheTtl: 600 } });
      const d = await r.json();
      if (d?.meta?.rating_oficial_ate) this.setCfg("oficial_ate", d.meta.rating_oficial_ate);
    } catch (e) { /* mantém o valor anterior */ }
  }

  async descobrirEventos(hoje) {
    const agora = Date.now();
    const novos = new Map();
    // eventos do dia (com a fase: em andamento, encerrado...)
    const etapas = await cbtm("eventos/etapas");
    const fases = etapas.events || {};
    // catálogo (nome, datas, formato) a cada 30 min
    if (agora - +this.cfg("catalogo_em", 0) > CATALOGO_A_CADA_MIN * 60e3) {
      const cat = await cbtm("eventos/catalogo?periodo=recent&pagina=1&tamanho=12");
      const up = await cbtm("eventos/catalogo?periodo=upcoming&pagina=1&tamanho=12").catch(() => null);
      for (const e of [...(cat.events?.items || []), ...(up?.events?.items || [])]) novos.set(e.slug, e);
      this.setCfg("catalogo_em", agora);
    }
    const corte = this.oficialAte();
    for (const e of novos.values()) {
      if (e.format !== "individual") continue; // duplas e equipes: fora do rating individual nesta versão
      if ((e.end || e.start) <= corte || e.start > hoje) continue;
      const { peso, tipo, estimado } = pesoDoEvento(e.name);
      const [cidade, uf] = [e.city || "", e.state || ""];
      this.sql.exec(
        `INSERT INTO eventos (slug, nome, inicio, fim, formato, cidade, uf, peso, tipo, estimado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET nome = excluded.nome, inicio = excluded.inicio, fim = excluded.fim,
           peso = excluded.peso, tipo = excluded.tipo, estimado = excluded.estimado`,
        e.slug, e.name, e.start, e.end || e.start, e.format, cidade, uf, peso, tipo, estimado ? 1 : 0,
      );
    }
    for (const [slug, info] of Object.entries(fases)) {
      this.sql.exec("UPDATE eventos SET fase = ? WHERE slug = ?", info.phase || "", slug);
    }
    // remove eventos que já entraram no rating oficial
    this.sql.exec("DELETE FROM eventos WHERE fim <= ?", corte);
  }

  precisaConsultar(ev, hoje, agora) {
    if (!ev.consultado_em) return true;
    const desde = agora - ev.consultado_em;
    if (ev.fase === "ongoing" || (ev.inicio <= hoje && ev.fim >= hoje)) return desde > 50e3; // a cada rodada
    const fimMs = Date.parse(ev.fim + "T23:59:59-03:00");
    if (agora - fimMs < 2 * 86400e3) return desde > 15 * 60e3; // até 2 dias depois: a cada 15 min
    return desde > 12 * 3600e3; // depois: 2× por dia
  }

  async rodada() {
    const agora = Date.now();
    const hoje = new Date(agora - 3 * 3600e3).toISOString().slice(0, 10); // horário de Brasília
    await this.atualizarOficialAte();
    await this.descobrirEventos(hoje);

    const eventos = this.sql.exec("SELECT slug, inicio, fim, fase, consultado_em, assinatura FROM eventos").toArray();
    const fila = eventos.filter((e) => this.precisaConsultar(e, hoje, agora))
      .sort((a, b) => (b.fase === "ongoing") - (a.fase === "ongoing") || a.consultado_em - b.consultado_em)
      .slice(0, MAX_CONSULTAS_POR_RODADA);

    let mudou = false;
    for (const ev of fila) {
      try {
        const c = enxugar(await cbtm(`eventos/${ev.slug}/consulta`));
        const texto = JSON.stringify(c);
        const assinatura = hash(texto);
        if (assinatura !== ev.assinatura) {
          this.sql.exec("UPDATE eventos SET consulta = ?, assinatura = ?, consultado_em = ? WHERE slug = ?", texto, assinatura, agora, ev.slug);
          mudou = true;
        } else {
          this.sql.exec("UPDATE eventos SET consultado_em = ? WHERE slug = ?", agora, ev.slug);
        }
      } catch (e) {
        this.sql.exec("UPDATE eventos SET consultado_em = ? WHERE slug = ?", agora, ev.slug);
      }
    }
    // versão nova do código (ex.: regra de peso corrigida): reaplica pesos e recalcula
    if (this.cfg("versao") !== VERSAO) {
      for (const ev of this.sql.exec("SELECT slug, nome FROM eventos").toArray()) {
        const { peso, tipo, estimado } = pesoDoEvento(ev.nome);
        this.sql.exec("UPDATE eventos SET peso = ?, tipo = ?, estimado = ? WHERE slug = ?", peso, tipo, estimado ? 1 : 0, ev.slug);
      }
      this.setCfg("versao", VERSAO);
      mudou = true;
    }
    if (mudou || !this.saida("resumo")) this.recalcular();
    this.setCfg("rodada_em", agora);
    return { consultados: fila.length, mudou };
  }

  recalcular() {
    const linhas = this.sql.exec("SELECT * FROM eventos WHERE consulta IS NOT NULL").toArray();
    const eventos = linhas.map((l) => ({ slug: l.slug, inicio: l.inicio, peso: l.peso, consulta: JSON.parse(l.consulta) }));
    const { atletas, porEvento, ratingAtual } = calcularTudo(eventos);
    this.setSaida("jogos_dia", this.jogosDoDia(linhas, eventos, porEvento, ratingAtual));
    const jogosPorEvento = new Map(porEvento.map((p) => [p.slug, p.jogos]));

    const lista = linhas.map((l) => ({
      slug: l.slug, nome: l.nome, inicio: l.inicio, fim: l.fim, cidade: l.cidade, uf: l.uf,
      peso: l.peso, tipo: l.tipo, peso_estimado: !!l.estimado, ao_vivo: l.fase === "ongoing",
      jogos: (jogosPorEvento.get(l.slug) || []).length,
    })).sort((a, b) => b.inicio.localeCompare(a.inicio));
    for (const l of lista) this.setSaida(`ev:${l.slug}`, { evento: l, jogos: jogosPorEvento.get(l.slug) || [] });

    const atl = {};
    for (const [k, a] of atletas) atl[k] = a;
    this.setSaida("atletas", atl);
    // Saldos por "NOME|CLUBE" para cada clube em que o atleta jogou (ele pode ter
    // trocado de clube) e por nome, quando o nome é de uma pessoa só.
    const saldos = {};
    const porNome = new Map();
    for (const a of atletas.values()) if (!a.jaOficial) porNome.set(a.nome, (porNome.get(a.nome) || 0) + 1);
    const saldosPorNome = {};
    for (const a of atletas.values()) {
      if (!a.saldo) continue;
      for (const alias of a.clubes) saldos[alias] = (saldos[alias] || 0) + a.saldo;
      if (porNome.get(a.nome) === 1) saldosPorNome[a.nome] = a.saldo;
    }
    this.setSaida("saldos_por_nome", saldosPorNome);
    this.setSaida("saldos", saldos);
    this.setSaida("dias", this.destaquesPorDia(porEvento, new Map(linhas.map((l) => [l.slug, l]))));
    this.setCfg("recalculado_em", Date.now());
    this.setSaida("resumo", {
      oficial_ate: this.oficialAte(),
      eventos: lista,
      atletas_com_jogos: atletas.size,
      jogos: lista.reduce((s, e) => s + e.jogos, 0),
    });
  }

  // Jogos de hoje nos eventos em andamento: os que ainda vão acontecer (com os
  // dois atletas definidos e o rating ao vivo de cada um, para o site calcular a
  // chance de vitória) e os já finalizados, para comparar previsão e resultado.
  jogosDoDia(linhas, eventos, porEvento, ratingAtual) {
    const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
    const saida = { dia: hoje, eventos: [] };
    const calculados = new Map(porEvento.map((p) => [p.slug, p.jogos]));
    for (const l of linhas) {
      if (!(l.inicio <= hoje && l.fim >= hoje)) continue;
      const c = eventos.find((e) => e.slug === l.slug)?.consulta;
      if (!c) continue;
      const membros = new Map();
      for (const e of c.entries || []) for (const m of e.members || []) membros.set(m.key, m);
      const lado = (p) => {
        const m = membros.get(p.key) || {};
        const nome = m.name || p.name, clube = m.club || p.club;
        const r = ratingAtual.get(identidade(nome, m.rating, clube)) ?? m.rating;
        return r ? { nome: normalizar(nome), clube, rating: r } : null;
      };
      const proximos = [];
      for (const g of c.games || []) {
        if (g.finished || g.wo || (g.day && g.day < hoje)) continue;
        const a = lado(g.first), b = lado(g.second);
        if (!a || !b) continue;
        proximos.push({ id: g.key, dia: g.day || hoje, hora: g.time || "", mesa: g.table || "", categoria: g.category, fase: g.phase, grupo: (g.group || "").trim(), a, b });
      }
      proximos.sort((x, y) => `${x.dia} ${x.hora}`.localeCompare(`${y.dia} ${y.hora}`) || x.mesa.localeCompare(y.mesa, "pt-BR", { numeric: true }));
      const finalizados = (calculados.get(l.slug) || []).filter((j) => j.dia === hoje).map((j) => ({
        id: j.id, hora: j.hora, mesa: j.mesa, categoria: j.categoria, fase: j.fase,
        a: { nome: j.a.nome, clube: j.a.clube, rating: j.a.antes, venceu: j.a.venceu, placar: j.a.placar, pontos: j.a.pontos },
        b: { nome: j.b.nome, clube: j.b.clube, rating: j.b.antes, venceu: j.b.venceu, placar: j.b.placar, pontos: j.b.pontos },
      })).reverse();
      if (proximos.length || finalizados.length)
        saida.eventos.push({ slug: l.slug, nome: l.nome, cidade: l.cidade, uf: l.uf, peso: l.peso, tipo: l.tipo, proximos, finalizados });
    }
    return saida;
  }

  // Destaques de cada dia (últimos 10 dias com jogos): quem mais ganhou e perdeu
  // pontos e as maiores zebras (vitória do atleta de menor rating).
  destaquesPorDia(porEvento, eventos) {
    const dias = new Map();
    for (const { slug, jogos } of porEvento) {
      const ev = eventos.get(slug);
      for (const j of jogos) {
        if (!dias.has(j.dia)) dias.set(j.dia, { atletas: new Map(), zebras: [], jogos: 0, eventos: new Set() });
        const d = dias.get(j.dia);
        d.jogos++;
        d.eventos.add(slug);
        for (const l of [j.a, j.b]) {
          const at = d.atletas.get(l.chave) || { chave: l.alias, nome: l.nome, clube: l.clube, pontos: 0, jogos: 0, vitorias: 0, rating_inicio: l.antes, evento: ev?.nome || "" };
          at.pontos += l.pontos;
          at.clube = l.clube;
          at.chave = l.alias;
          at.jogos++;
          if (l.venceu) at.vitorias++;
          d.atletas.set(l.chave, at);
        }
        const [v, p] = j.a.venceu ? [j.a, j.b] : [j.b, j.a];
        if (v.antes < p.antes) d.zebras.push({ vencedor: v.nome, clube_vencedor: v.clube, chave_vencedor: v.alias, rating_vencedor: v.antes, perdedor: p.nome, rating_perdedor: p.antes, diferenca: p.antes - v.antes, pontos: v.pontos, categoria: j.categoria, fase: j.fase, evento: ev?.nome || "", hora: j.hora });
      }
    }
    const saida = {};
    for (const dia of [...dias.keys()].sort().slice(-10)) {
      const d = dias.get(dia);
      const lista = [...d.atletas.values()];
      saida[dia] = {
        jogos: d.jogos, eventos: d.eventos.size, atletas: lista.length,
        ganhadores: lista.filter((a) => a.pontos > 0).sort((a, b) => b.pontos - a.pontos).slice(0, 30),
        perdedores: lista.filter((a) => a.pontos < 0).sort((a, b) => a.pontos - b.pontos).slice(0, 10),
        zebras: d.zebras.sort((a, b) => b.diferenca - a.diferenca).slice(0, 15),
      };
    }
    return saida;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/rodada") return json(await this.rodada(), 200, 0);
    if (p === "/api/resumo") {
      const r = this.saida("resumo") || { eventos: [] };
      r.rodada_em = +this.cfg("rodada_em", 0) || null;
      r.recalculado_em = +this.cfg("recalculado_em", 0) || null;
      return json(r);
    }
    if (p === "/api/jogos-do-dia") return json(this.saida("jogos_dia") || { eventos: [] });
    if (p === "/api/destaques") {
      const dias = this.saida("dias") || {};
      const lista = Object.keys(dias).sort();
      const dia = url.searchParams.get("dia") && dias[url.searchParams.get("dia")] ? url.searchParams.get("dia") : lista.at(-1);
      return json({ dia: dia || null, dias: lista, ...(dias[dia] || {}) });
    }
    if (p === "/api/saldos") return json({ oficial_ate: this.oficialAte(), saldos: this.saida("saldos") || {}, por_nome: this.saida("saldos_por_nome") || {} });
    if (p.startsWith("/api/evento/")) {
      const d = this.saida(`ev:${decodeURIComponent(p.slice(12))}`);
      return d ? json(d) : json({ erro: "evento não encontrado" }, 404);
    }
    if (p === "/api/atletas") {
      const q = normalizar(url.searchParams.get("q") || "");
      const atl = this.saida("atletas") || {};
      const r = Object.entries(atl).filter(([, a]) => !a.jaOficial && q.length >= 2 && (a.nome.includes(q) || a.clubes.some((c) => c.includes(q)))).slice(0, 30)
        .map(([, a]) => ({ chave: a.clubes.at(-1), nome: a.nome, clube: a.clube, clubes: a.clubes.length, oficial: a.oficial, atual: a.atual, saldo: a.saldo, jogos: a.jogos }));
      return json({ itens: r });
    }
    if (p.startsWith("/api/atleta/")) {
      // aceita a identidade interna (NOME#RATING) ou "NOME|CLUBE" de qualquer clube em que ele jogou
      const pedido = decodeURIComponent(p.slice(12));
      const atl = this.saida("atletas") || {};
      const candidatos = Object.keys(atl).filter((k) => atl[k].clubes.includes(pedido));
      let id = atl[pedido] ? pedido : candidatos.find((k) => !atl[k].jaOficial) || candidatos[0];
      if (!id) {
        const nome = pedido.split("|")[0];
        const mesmos = Object.keys(atl).filter((k) => atl[k].nome === nome && !atl[k].jaOficial);
        if (mesmos.length === 1) id = mesmos[0];
      }
      const a = id && atl[id];
      if (!a) return json({ erro: "atleta sem jogos pendentes de publicação oficial" }, 404);
      const jogos = [];
      for (const slug of a.eventos) {
        const ev = this.saida(`ev:${slug}`);
        for (const j of ev?.jogos || []) {
          if (j.a.chave === id || j.b.chave === id) {
            const eu = j.a.chave === id ? j.a : j.b;
            const ele = j.a.chave === id ? j.b : j.a;
            jogos.push({ evento: ev.evento.nome, slug, dia: j.dia, hora: j.hora, categoria: j.categoria, fase: j.fase,
              adversario: ele.nome, clube_adversario: ele.clube, rating_adversario: ele.antes, clube: eu.clube,
              antes: eu.antes, pontos: eu.pontos, venceu: eu.venceu, placar: `${eu.placar} × ${ele.placar}`, peso: ev.evento.peso,
              // sets do ponto de vista do atleta: [pontos dele, pontos do adversário]
              sets: (j.sets || []).map((x) => (j.a.chave === id ? x : [x[1], x[0]])) });
          }
        }
      }
      return json({ chave: a.clubes.at(-1), id, ...a, jogos });
    }
    return json({ erro: "rota não encontrada" }, 404);
  }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" } });
    const url = new URL(req.url);
    if (url.pathname === "/" ) return json({ servico: "CASQUINHA · pontos ao vivo", rotas: ["/api/jogos-do-dia", "/api/resumo", "/api/destaques?dia=AAAA-MM-DD", "/api/saldos", "/api/evento/{slug}", "/api/atletas?q=", "/api/atleta/{chave}"] });
    if (!url.pathname.startsWith("/api/")) return json({ erro: "rota não encontrada" }, 404);
    // cache de 30 s na borda: protege a CBTM e o Durable Object de acessos repetidos
    const cache = caches.default;
    const hit = await cache.match(req);
    if (hit) return hit;
    const stub = env.ESTADO.get(env.ESTADO.idFromName("principal"));
    const resp = await stub.fetch(req);
    if (resp.ok) ctx.waitUntil(cache.put(req, resp.clone()));
    return resp;
  },
  async scheduled(evento, env, ctx) {
    const stub = env.ESTADO.get(env.ESTADO.idFromName("principal"));
    ctx.waitUntil(stub.fetch("https://interno/rodada"));
  },
};
