# tm-pontos-ao-vivo

Pontos de rating de cada partida oficial, calculados **logo depois que o
resultado é lançado na mesa de controle** e aparece no sistema da CBTM.
Alimenta a seção **Ao vivo** do site CASQUINHA e a coluna "Provável posição
amanhã" do Ranking de Clubes.

**API pública:** https://casquinha-ao-vivo.matheusbruno045.workers.dev

| Rota | Conteúdo |
|---|---|
| `/api/resumo` | eventos com jogos ainda não publicados no rating oficial |
| `/api/evento/{slug}` | jogos calculados do evento, com o rating antes e os pontos de cada atleta |
| `/api/atletas?q=nome` | busca de atletas com jogos a publicar |
| `/api/atleta/{chave}` | rating oficial, rating ao vivo, saldo e jogos do atleta |
| `/api/saldos` | saldo de cada atleta (usado na projeção do Ranking de Clubes) |

## Como funciona
- Um **Cloudflare Worker** com agendamento **a cada minuto** consulta o CBTM Live:
  os eventos do dia (`/eventos/etapas`), o catálogo dos últimos ~30 dias e a
  consulta de cada evento (`/eventos/{slug}/consulta`, com inscrições e jogos).
- Um **Durable Object** (SQLite) guarda os eventos e recalcula tudo quando
  algo muda. As respostas ficam 30 s em cache, para não sobrecarregar a CBTM.
- Eventos em andamento são lidos a cada minuto; nos 2 dias seguintes ao fim,
  a cada 15 min; depois, 2× por dia, até entrarem no rating oficial.

## Regra do cálculo (validada)
Manual do Tênis de Mesa CBTM 2026, item 1.7.2.5.5. Cada jogo usa o **rating
dos dois atletas imediatamente antes do jogo** (atualizado jogo a jogo), a
tabela de vitória esperada/inesperada pela diferença de rating e o **peso do
evento** (Brasileirão 18, Ouro 9, Prata 6, Estadual 3, Seletiva Nacional 12,
Regional 1; uma seletiva dentro de outro evento usa o peso desse evento).

Validação: os 60 confrontos do Estadual de Chapecó (set/2026) recalculados a
partir dos perfis oficiais batem 100% (`test/gabarito_chapeco_2026.json`).

- O rating de entrada de cada atleta vem da inscrição no evento (rating oficial).
- Os eventos ainda não publicados são encadeados em ordem cronológica.
- W.O. não conta. Duplas e equipes ficam de fora nesta versão.
- **Identidade do atleta = nome + rating oficial de entrada** (não o clube). O
  atleta pode jogar por clubes diferentes no ano, e cada inscrição mostra o
  clube daquele evento. Os saldos saem para todos os clubes em que ele jogou e
  também pelo nome (quando o nome é de uma pessoa só), para chegar ao clube
  atual na projeção do Ranking de Clubes.
- **Eventos já computados pela CBTM para um atleta:** se a mesma pessoa aparece
  num evento posterior com outro rating de entrada, os eventos anteriores dela
  já estão no oficial e saem do saldo (evita contar duas vezes). Homônimos não
  se confundem: aparecem juntos num mesmo evento.
- O corte ("rating oficial até") vem do `tm-clubes`, que verifica toda segunda
  até que data a CBTM já computou os jogos.

## Limitações conhecidas
- O catálogo do CBTM Live só alcança ~30 dias. Eventos mais antigos que ainda
  não entraram no oficial não aparecem.
- Eventos cujo tipo não é reconhecido pelo nome recebem peso 1 e aparecem
  marcados como "peso estimado".

## Desenvolvimento
```bash
npm install
npm test                 # testes do cálculo (node --test)
npx wrangler deploy      # publica (precisa de CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID)
```
