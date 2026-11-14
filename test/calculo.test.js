import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calcularTudo, chaveAtleta, pesoDoEvento, pontosDoJogo, processarEvento } from "../src/calculo.js";

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
  assert.equal(r.get(chaveAtleta("ANA SILVA", "CLUBE X - SC")), 1530 - 33); // perdeu inesperada: 11 × 3
});

test("encadeia eventos e calcula o saldo sobre o oficial", () => {
  const { atletas } = calcularTudo([
    { slug: "e2", inicio: "2026-11-14", peso: 3, consulta: consulta([jogo(1, "09:00", true)]) },
    { slug: "e1", inicio: "2026-11-07", peso: 3, consulta: consulta([jogo(1, "09:00", true)]) },
  ]);
  const ana = atletas.get(chaveAtleta("ANA SILVA", "CLUBE X - SC"));
  assert.equal(ana.oficial, 1500);
  // 1º evento: Δ 10, esperada, +30 (BIA −24 → 1466). 2º evento: Δ 64, esperada, +24.
  assert.equal(ana.atual, 1500 + 30 + 24);
  assert.equal(ana.saldo, 54);
  assert.deepEqual(ana.eventos, ["e1", "e2"]);
});
