# tm-pontos-ao-vivo

Pontos de rating de cada partida oficial, calculados **logo depois que o
resultado é lançado na mesa de controle** e aparece no sistema da CBTM.

> Status: planejado.

## Escopo
1. Acompanhar os torneios em andamento no CBTM Live
   (`/api/local/eventos/etapas`, `/api/local/campeonatos`, `/api/local/eventos/{slug}/consulta`).
2. A cada 1–2 minutos durante os eventos, buscar os jogos recém-finalizados.
3. Calcular os pontos pela tabela oficial (Manual CBTM 2026, item 1.7.2.5.5):
   vitória esperada ou inesperada, faixa de diferença de rating e peso do evento
   (Brasileirão 18, Seletiva 12, Ouro 9, Prata 6, Estadual 3, Regional 1).
4. Mostrar o rating "ao vivo" do atleta e quanto o próximo jogo vale.
5. Quando a CBTM publicar o rating oficial, passar a usar o valor oficial.

## Pendências técnicas
- Confirmar o formato de um jogo finalizado na consulta do evento (campos de
  atletas, placar e horário).
- Definir onde o serviço roda: precisa de agendamento a cada 1–2 minutos
  durante os eventos, então GitHub Actions não serve; a ideia é usar um worker
  agendado, por exemplo Cloudflare Workers com Cron Triggers.
