// Cálculo dos pontos de rating da CBTM, jogo a jogo.
//
// Regra (Manual do Tênis de Mesa 2026, item 1.7.2.5.5), validada contra os
// perfis oficiais: cada jogo usa o rating dos dois atletas IMEDIATAMENTE antes
// do jogo (atualizado jogo a jogo), a tabela básica de vitória esperada ou
// inesperada e o peso do evento.

// [Δ mínimo, Δ máximo, pontos do vencedor, pontos do perdedor]
export const ESPERADAS = [
  [750, Infinity, 1, 0], [500, 749, 2, 0], [400, 499, 3, 1], [300, 399, 4, 2], [200, 299, 5, 3],
  [150, 199, 6, 4], [100, 149, 7, 5], [50, 99, 8, 6], [25, 49, 9, 7], [0, 24, 10, 8],
];
export const INESPERADAS = [
  [500, Infinity, 30, 22], [400, 499, 26, 20], [300, 399, 23, 18], [200, 299, 20, 16], [150, 199, 18, 14],
  [100, 149, 16, 12], [50, 99, 14, 11], [25, 49, 12, 10], [0, 24, 11, 9],
];

// Pesos do Manual 2026 (item 1.7.2.3). O primeiro padrão que casar vale.
// Uma seletiva realizada dentro de outro evento usa o peso desse evento (Manual,
// observação do item 1.7.2.3), por isso "SELETIVA" só vale 12 se nada antes casar.
export const PESOS = [
  [/BRASILEIRAO/, 18, "Brasileirão"],
  [/COPA BRASIL.*OURO|OURO.*COPA BRASIL/, 9, "Copa Brasil Ouro"],
  [/COPA BRASIL.*PRATA|PRATA.*COPA BRASIL/, 6, "Copa Brasil Prata"],
  // "SÉRIE OURO/PRATA" de um estadual continua sendo estadual
  [/ESTADUAL|DISTRITAL|PAULISTAO|CAMPEONATO (CEARENSE|MINEIRO|PARAENSE|CATARINENSE|GAUCHO|PARANAENSE|AMAPAENSE)/, 3, "Estadual"],
  [/SELETIVA/, 12, "Seletiva Nacional"],
  // "Liga Nipo Brasileira" é regional (por isso Brasileirão exige "BRASILEIRAO")
  [/REGIONAL|LIGA|COPA MG/, 1, "Regional"],
];

export const normalizar = (s) =>
  String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

export const chaveAtleta = (nome, clube) => `${normalizar(nome)}|${normalizar(clube)}`;

export function pesoDoEvento(nome) {
  const n = normalizar(nome);
  for (const [re, peso, tipo] of PESOS) if (re.test(n)) return { peso, tipo, estimado: false };
  return { peso: 1, tipo: "Não identificado", estimado: true };
}

function faixa(tabela, delta) {
  return tabela.find(([lo, hi]) => delta >= lo && delta <= hi);
}

/** Pontos de um jogo: [pontos do A, pontos do B]. */
export function pontosDoJogo(ratingA, ratingB, aVenceu, peso) {
  const delta = Math.abs(ratingA - ratingB);
  const favoritoA = ratingA >= ratingB;
  const esperada = aVenceu === favoritoA;
  const [, , vence, perde] = faixa(esperada ? ESPERADAS : INESPERADAS, delta);
  const perda = perde * peso ? -perde * peso : 0; // evita -0
  return aVenceu ? [vence * peso, perda] : [perda, vence * peso];
}

/**
 * Processa um evento (resposta de /api/local/eventos/{slug}/consulta).
 * ratingAtual: Map chaveAtleta -> rating corrente (já com eventos anteriores); é ATUALIZADO.
 * Devolve os jogos calculados, na ordem em que aconteceram.
 */
export function processarEvento(consulta, peso, ratingAtual) {
  const membros = new Map();
  for (const e of consulta.entries || []) {
    if (e.kind !== "individual") continue;
    for (const m of e.members || []) membros.set(m.key, m);
  }
  const jogos = (consulta.games || [])
    .filter((g) => g.finished && !g.wo && g.first?.key && g.second?.key && (g.first.won || g.second.won))
    .sort((a, b) => `${a.day} ${a.time}`.localeCompare(`${b.day} ${b.time}`) || a.number - b.number);

  const saida = [];
  for (const g of jogos) {
    const lados = [g.first, g.second].map((p) => {
      const m = membros.get(p.key) || {};
      const nome = m.name || p.name;
      const clube = m.club || p.club;
      const chave = chaveAtleta(nome, clube);
      if (!ratingAtual.has(chave) && m.rating) ratingAtual.set(chave, m.rating);
      return { chave, nome: normalizar(nome), clube, rating: ratingAtual.get(chave) };
    });
    if (lados.some((l) => !l.rating)) continue; // sem rating de entrada: não dá para calcular
    const [a, b] = lados;
    const [pa, pb] = pontosDoJogo(a.rating, b.rating, !!g.first.won, peso);
    ratingAtual.set(a.chave, a.rating + pa);
    ratingAtual.set(b.chave, b.rating + pb);
    saida.push({
      id: g.key,
      categoria: g.category,
      fase: g.phase,
      grupo: (g.group || "").trim(),
      dia: g.day,
      hora: g.time,
      mesa: g.table,
      sets: g.sets,
      a: { chave: a.chave, nome: a.nome, clube: a.clube, antes: a.rating, pontos: pa, venceu: !!g.first.won, placar: g.first.score },
      b: { chave: b.chave, nome: b.nome, clube: b.clube, antes: b.rating, pontos: pb, venceu: !!g.second.won, placar: g.second.score },
    });
  }
  return saida;
}

/**
 * Encadeia os eventos pendentes em ordem cronológica e soma por atleta.
 * eventos: [{slug, nome, inicio, peso, consulta}]
 */
export function calcularTudo(eventos) {
  const ratingAtual = new Map();
  const ratingOficial = new Map();
  const atletas = new Map();
  const porEvento = [];
  const ordenados = [...eventos].sort((x, y) => x.inicio.localeCompare(y.inicio) || x.slug.localeCompare(y.slug));
  for (const ev of ordenados) {
    // o rating de entrada da 1ª aparição é o oficial
    for (const e of ev.consulta.entries || [])
      for (const m of e.members || []) {
        const k = chaveAtleta(m.name, m.club);
        if (m.rating && !ratingOficial.has(k)) ratingOficial.set(k, m.rating);
      }
    const jogos = processarEvento(ev.consulta, ev.peso, ratingAtual);
    porEvento.push({ slug: ev.slug, jogos });
    for (const j of jogos)
      for (const lado of [j.a, j.b]) {
        const at = atletas.get(lado.chave) || { nome: lado.nome, clube: lado.clube, oficial: ratingOficial.get(lado.chave) ?? lado.antes, jogos: 0, vitorias: 0, eventos: [] };
        at.jogos += 1;
        if (lado.venceu) at.vitorias += 1;
        if (at.eventos[at.eventos.length - 1] !== ev.slug) at.eventos.push(ev.slug);
        atletas.set(lado.chave, at);
      }
  }
  for (const [k, at] of atletas) {
    at.atual = ratingAtual.get(k);
    at.saldo = at.atual - at.oficial;
  }
  return { atletas, porEvento };
}
