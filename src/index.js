// CASQUINHA · pontos ao vivo
// Worker (API pública) + Durable Object "Estado" (coleta a cada minuto e guarda os dados).
import { DurableObject } from "cloudflare:workers";
import { calcularTudo, normalizar, pesoDoEvento } from "./calculo.js";

const CBTM = "https://live.cbtm.org.br/api/local/";
const UA = "casquinha-ao-vivo/1.0 (pontos de rating; consulta a cada minuto durante eventos)";
const VERSAO = "2"; // aumente quando mudar a regra de cálculo
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
    games: (c.games || []).filter((g) => g.finished).map((g) => ({
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
    const { atletas, porEvento } = calcularTudo(eventos);
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
    const saldos = {};
    for (const [k, a] of atletas) if (a.saldo) saldos[k] = a.saldo;
    this.setSaida("saldos", saldos);
    this.setCfg("recalculado_em", Date.now());
    this.setSaida("resumo", {
      oficial_ate: this.oficialAte(),
      eventos: lista,
      atletas_com_jogos: atletas.size,
      jogos: lista.reduce((s, e) => s + e.jogos, 0),
    });
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
    if (p === "/api/saldos") return json({ oficial_ate: this.oficialAte(), saldos: this.saida("saldos") || {} });
    if (p.startsWith("/api/evento/")) {
      const d = this.saida(`ev:${decodeURIComponent(p.slice(12))}`);
      return d ? json(d) : json({ erro: "evento não encontrado" }, 404);
    }
    if (p === "/api/atletas") {
      const q = normalizar(url.searchParams.get("q") || "");
      const atl = this.saida("atletas") || {};
      const r = Object.entries(atl).filter(([k]) => q.length >= 2 && k.includes(q)).slice(0, 30)
        .map(([chave, a]) => ({ chave, nome: a.nome, clube: a.clube, oficial: a.oficial, atual: a.atual, saldo: a.saldo, jogos: a.jogos }));
      return json({ itens: r });
    }
    if (p.startsWith("/api/atleta/")) {
      const chave = decodeURIComponent(p.slice(12));
      const a = (this.saida("atletas") || {})[chave];
      if (!a) return json({ erro: "atleta sem jogos pendentes de publicação oficial" }, 404);
      const jogos = [];
      for (const slug of a.eventos) {
        const ev = this.saida(`ev:${slug}`);
        for (const j of ev?.jogos || []) {
          if (j.a.chave === chave || j.b.chave === chave) {
            const eu = j.a.chave === chave ? j.a : j.b;
            const ele = j.a.chave === chave ? j.b : j.a;
            jogos.push({ evento: ev.evento.nome, slug, dia: j.dia, hora: j.hora, categoria: j.categoria, fase: j.fase,
              adversario: ele.nome, clube_adversario: ele.clube, rating_adversario: ele.antes,
              antes: eu.antes, pontos: eu.pontos, venceu: eu.venceu, placar: `${eu.placar} × ${ele.placar}`, sets: j.sets, peso: ev.evento.peso });
          }
        }
      }
      return json({ chave, ...a, jogos });
    }
    return json({ erro: "rota não encontrada" }, 404);
  }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" } });
    const url = new URL(req.url);
    if (url.pathname === "/" ) return json({ servico: "CASQUINHA · pontos ao vivo", rotas: ["/api/resumo", "/api/saldos", "/api/evento/{slug}", "/api/atletas?q=", "/api/atleta/{chave}"] });
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
