# Ideia guardada: separar o rodízio de pessoas dos robôs

Pedido em 27/10/2026. Ainda não começou.

## O que o usuário escolheu
- Dois serviços separados no PM2: um só para o rodízio de pessoas (Ativo ↔ URA) e outro só para os robôs (pânico, modo dos robôs, cliente de risco). Cada um com o seu liga/desliga na aba Serviços.
- Com o rodízio de pessoas pausado ou desligado, quem está na URA **fica onde está**: ninguém sobe nem volta. Para levar todos ao Ativo continua valendo "Alocar todos no Ativo".

## O que já existe
- Desligar o interruptor do pânico: o rodízio de pessoas segue, e o BenURA não mexe nos robôs.
- Desligar o componente "rodízio" (aba Serviços): para os dois ao mesmo tempo.

## Pontos de atenção para o desenho
- O pânico precisa do status de quem está na URA: livres, há quanto tempo e quem é fixo. Para não dobrar as consultas à Argus (risco de 429):
  - o serviço de pessoas lê a URA e publica um retrato a cada ciclo;
  - o de robôs usa esse retrato quando ele está fresco e, sem ele (pessoas desligado), lê a Argus sozinho.
- "Último livre saindo" depende da regra do ocioso. Com as pessoas pausadas, ninguém sai: o retrato diz isso.
- O webhook da Argus (`:3000/webhook`) é um endereço só, e os tipos 4 e 5 alimentam o relatório e os robôs. É preciso decidir quem recebe e quem repassa.
- Relatório do dia, termômetro e status da URA: decidir de que lado ficam.
- Painel: as ações (tabela `ACOES` em `src/painel/servicos.js`) e o `/health` usados pela tela passam a apontar para o serviço certo.
- Os testes que montam o `RodizioService` e os cenários (`test/rodizio/cenarios.js`) precisam continuar passando.
