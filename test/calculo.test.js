import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calcularTudo, chaveAtleta, identidade, pesoDoEvento, pontosDoJogo, processarEvento } from "../src/calculo.js";

const gabarito = JSON.parse(readFileSync(new URL("./gabarito_chapeco_2026.json", import.meta.url)));

test("bate com os pontos oficiais da CBTM (Estadual de Chapecó, set/2026)", () => {
  assert.ok(gabarito.jogos.length >= 50);
  for (const j of gabarito.jogos) {
    assert.deepEqual(pontosDoJogo(j.ra, j.rb, j.aVenceu, gabarito.peso), [j.pa, j.pb], JSON.stringify(j));
  }
});

test("tabela: esperada, inesperada e faixa de 750+", () => {
  assert.deepEqual(pontosDoJogo(2000, 1000, true, 3), [3, 0]);
  assert.deepEqual(pontosDoJogo(2000, 1000, false, 3), [-66, 90]); // zebra Δ ≥ 500
  assert.deepEqual(pontosDoJogo(1500, 1490, true, 18), [180, -144]);
});

test("pesos dos eventos (Manual 2026)", () => {
  assert.equal(pesoDoEvento("Brasileirão de Inverno Interclubes").peso, 18);
  assert.equal(pesoDoEvento("TMB - Copa Brasil Ouro de Tênis de Mesa - Fortaleza/CE").peso, 9);
  assert.equal(pesoDoEvento("TMB - Copa Brasil Prata - Natal/RN").peso, 6);
  assert.equal(pesoDoEvento("TMB Estadual - 7ª Etapa - Porto Alegre/RS").peso, 3);
  assert.equal(pesoDoEvento("TMB - PAULISTÃO 2026 - Jacareí/SP").peso, 3);
  assert.equal(pesoDoEvento("TMB Regional - Liga Manauara 7ª Etapa").peso, 1);
  assert.equal(pesoDoEvento("Open Ping Drive").estimado, true);
  assert.equal(pesoDoEvento("Seletiva Nacional Olímpica e Paralímpica 2026").peso, 12);
  assert.equal(pesoDoEvento("TMB Estadual - 8ª Etapa Amazonense-Seletiva").peso, 3); // seletiva dentro de estadual
  assert.equal(pesoDoEvento("TMB REGIONAL - 14ª Etapa - Liga Nipo Brasileira de Tênis de Mesa").peso, 1);
  assert.equal(pesoDoEvento("TMB Estadual - 5ª Etapa Ranking - Recife/PE 2026 - SÉRIE OURO").peso, 3);
  assert.equal(pesoDoEvento("TMB BRASILEIRÃO DE VERÃO INTERCLUBES - BLUMENAU/SC").peso, 18);
  assert.equal(pesoDoEvento("Copa Brasil Ouro Maceió/AL - 2026").peso, 9);
});

const consulta = (jogos) => ({
  entries: [
    { kind: "individual", members: [{ key: "a", name: "ANA  SILVA", club: "CLUBE X - SC", rating: 1500 }] },
    { kind: "individual", members: [{ key: "b", name: "BIA SOUZA", club: "CLUBE Y - SC", rating: 1490 }] },
    { kind: "technician", members: [{ key: "t", name: "TEC", club: "CLUBE X - SC", rating: 0 }] },
  ],
  games: jogos,
});
const jogo = (n, hora, aVence, extra = {}) => ({
  key: `g${n}`, number: n, day: "2026-11-14", time: hora, finished: true, wo: false, category: "ABSOLUTO A FEM", phase: "Grupo",
  first: { key: "a", name: "ANA SILVA", club: "CLUBE X - SC", won: aVence, score: aVence ? 3 : 1 },
  second: { key: "b", name: "BIA SOUZA", club: "CLUBE Y - SC", won: !aVence, score: aVence ? 1 : 3 },
  sets: [], ...extra,
});

test("jogo a jogo: o rating é atualizado antes do jogo seguinte e W.O. não conta", () => {
  const r = new Map();
  const j = processarEvento(consulta([jogo(2, "10:00", false), jogo(1, "09:00", true), jogo(3, "11:00", true, { wo: true })]), 3, r);
  assert.equal(j.length, 2);
  assert.equal(j[0].id, "g1"); // ordenado por horário
  assert.deepEqual([j[0].a.antes, j[0].a.pontos], [1500, 30]); // Δ 10, esperada: 10 × 3
  assert.deepEqual([j[1].a.antes, j[1].b.antes], [1530, 1466]); // Δ 64 no 2º jogo
  assert.equal(r.get(identidade("ANA SILVA", 1500)), 1530 - 33); // perdeu inesperada: 11 × 3
});

test("encadeia eventos e calcula o saldo sobre o oficial", () => {
  const { atletas } = calcularTudo([
    { slug: "e2", inicio: "2026-11-14", peso: 3, consulta: consulta([jogo(1, "09:00", true)]) },
    { slug: "e1", inicio: "2026-11-07", peso: 3, consulta: consulta([jogo(1, "09:00", true)]) },
  ]);
  const ana = atletas.get(identidade("ANA SILVA", 1500));
  assert.equal(ana.oficial, 1500);
  // 1º evento: Δ 10, esperada, +30 (BIA −24 → 1466). 2º evento: Δ 64, esperada, +24.
  assert.equal(ana.atual, 1500 + 30 + 24);
  assert.equal(ana.saldo, 54);
  assert.deepEqual(ana.eventos, ["e1", "e2"]);
});

test("atleta que troca de clube entre eventos continua sendo a mesma pessoa", () => {
  const ev = (clubeAna, n) => ({
    entries: [
      { kind: "individual", members: [{ key: "a", name: "ANA SILVA", club: clubeAna, rating: 1500 }] },
      { kind: "individual", members: [{ key: "b", name: "BIA SOUZA", club: "CLUBE Y - SC", rating: 1490 }] },
    ],
    games: [{ ...jogo(n, "09:00", true), first: { key: "a", name: "ANA SILVA", club: clubeAna, won: true, score: 3 } }],
  });
  const { atletas } = calcularTudo([
    { slug: "e1", inicio: "2026-11-07", peso: 3, consulta: ev("CLUBE ANTIGO - SC", 1) },
    { slug: "e2", inicio: "2026-11-14", peso: 3, consulta: ev("CLUBE NOVO - PR", 1) },
  ]);
  const ana = atletas.get(identidade("ANA SILVA", 1500));
  assert.equal(ana.jogos, 2); // os dois eventos somam no mesmo atleta
  assert.equal(ana.atual, 1500 + 30 + 24); // o 2º evento parte do rating já atualizado
  assert.equal(ana.clube, "CLUBE NOVO - PR");
  assert.deepEqual(ana.clubes, [chaveAtleta("ANA SILVA", "CLUBE ANTIGO - SC"), chaveAtleta("ANA SILVA", "CLUBE NOVO - PR")]);
});

test("evento já computado pela CBTM para o atleta não entra no saldo (rating de entrada mudou)", () => {
  const ev = (rating, n) => ({
    entries: [
      { kind: "individual", members: [{ key: "a", name: "ANA SILVA", club: "CLUBE X - SC", rating }] },
      { kind: "individual", members: [{ key: "b", name: "BIA SOUZA", club: "CLUBE Y - SC", rating: 1490 }] },
    ],
    games: [jogo(n, "09:00", true)],
  });
  const { atletas } = calcularTudo([
    { slug: "e1", inicio: "2026-10-18", peso: 3, consulta: ev(1500, 1) }, // já no oficial: o rating dela virou 1530
    { slug: "e2", inicio: "2026-11-08", peso: 3, consulta: ev(1530, 1) },
  ]);
  const antiga = atletas.get(identidade("ANA SILVA", 1500));
  const nova = atletas.get(identidade("ANA SILVA", 1530));
  assert.equal(antiga.jaOficial, true);
  assert.equal(antiga.saldo, 0);
  assert.equal(nova.oficial, 1530);
  assert.ok(nova.saldo > 0 && !nova.jaOficial);
});

test("homônimos no mesmo evento continuam separados e os dois contam", () => {
  const c = {
    entries: [
      { kind: "individual", members: [{ key: "a1", name: "JOAO CASTRO", club: "CLUBE X - SC", rating: 900 }] },
      { kind: "individual", members: [{ key: "a2", name: "JOAO CASTRO", club: "CLUBE X - SC", rating: 250 }] },
      { kind: "individual", members: [{ key: "b", name: "BIA SOUZA", club: "CLUBE Y - SC", rating: 600 }] },
    ],
    games: [
      { ...jogo(1, "09:00", true), first: { key: "a1", name: "JOAO CASTRO", club: "CLUBE X - SC", won: true, score: 3 } },
      { ...jogo(2, "10:00", true), first: { key: "a2", name: "JOAO CASTRO", club: "CLUBE X - SC", won: true, score: 3 } },
    ],
  };
  const { atletas } = calcularTudo([{ slug: "e1", inicio: "2026-11-14", peso: 3, consulta: c }]);
  assert.ok(atletas.get(identidade("JOAO CASTRO", 900)).saldo > 0);
  assert.ok(atletas.get(identidade("JOAO CASTRO", 250)).saldo > 0);
});
