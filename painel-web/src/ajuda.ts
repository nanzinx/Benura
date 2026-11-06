/**
 * [NOVO] Manual da supervisão (aba Ajuda): o que cada botão faz e o que cada número quer dizer,
 * em português simples. Fonte: o README. Mudou uma regra, mude aqui também.
 */

export interface SecaoDaAjuda { id: string; titulo: string; onde: string; itens: string[] }

export const SECOES_DA_AJUDA: SecaoDaAjuda[] = [
  {
    id: 'dia',
    titulo: 'O dia do BenURA',
    onde: 'Automático, de segunda a sexta',
    itens: [
      'Às 08:00 a agenda religa a automação, e às 18:00 desliga. A noite e o fim de semana não entram no relatório.',
      'O roteador decide quem pode ir para a URA hoje: quem bateu a meta ontem, quem vende hoje e os fixos.',
      '"Ontem" é o dia útil anterior (sem fim de semana, feriado nacional, Carnaval e Corpus Christi). Se o Carrossel mandar um feriado, a carga do dia espera: o cartão "Vendas e filas" diz o motivo, os fixos já sobem, e basta colar a esteira do dia útil em /manual.',
      'O rodízio leva para a URA quem atendeu uma ligação no Ativo e ficou livre, e devolve ao Ativo quem ficou livre na URA por 2 minutos seguidos. O tempo livre é o "Tempo" da Argus.',
      'O BenURA não loga nem desloga humano: só troca de grupo. A telefonia troca quando a pessoa fica livre, com um pequeno atraso da discadora.',
      'Conta de supervisor (ramal com o nome de um supervisor, como a da Ariel) não fica na URA: não sobe nem com venda ou fixo, e volta ao Ativo assim que não estiver em ligação. Só "Trazer para a URA" no painel a põe lá.',
    ],
  },
  {
    id: 'panico',
    titulo: 'Robôs e o pânico',
    onde: 'Aba URA e robôs',
    itens: [
      'Quem liga os robôs é a supervisão, pelo painel da Argus. O BenURA nunca liga robô: no modo "Só pânico" ele só desliga quando precisa.',
      'Pânico com 0 livre na URA: desliga todos os robôs, inclusive os em ligação.',
      'Pânico com 1 livre comum que sai por ociosidade em até 60 s (URA não calma): desliga os robôs parados; os em ligação terminam a chamada enquanto ele ainda está na URA.',
      'Pânico com 1 fixo livre há menos de 3 min (URA não calma): desliga a metade dos robôs ligados, de novo a cada 60 s (8 → 4 → 2 → 1).',
      'Com 2 ou mais livres não faz nada. Com a URA calma e 1 livre (fixo ou não), também não: os robôs seguem até ele atender ou ir para o Ativo, e aí sobra 0 livre.',
      'Cliente de risco em ligação (interruptor ligado): desliga os robôs parados e mostra uma faixa vermelha no topo.',
    ],
  },
  {
    id: 'robos-automatico',
    titulo: 'Robôs no automático (quantos por livre)',
    onde: 'Aba URA e robôs → Rodízio dos robôs',
    itens: [
      'O BenURA mede quantas derivações cada robô ligado gera por minuto nos últimos 30 min e liga robôs para cada livre receber uma ligação dentro da espera alvo do status da URA.',
      'Espera alvo: calma 45 s, normal 90 s, agressiva 120 s. Quanto menor a espera alvo, mais robôs por livre. A agressiva liga menos para não gerar callback.',
      'Cada status tem um piso e um teto de robôs por livre: calma 20, normal de 4 a 10, agressiva de 2 a 6. Com 1 livre só, vale o teto do status (na calma, 40).',
      'URA calma: com 1 livre, 40 robôs; com 2 livres ou mais, todos os robôs (potência máxima). Na calma eles ligam de uma vez, sem degraus.',
      'No começo do dia, com poucas derivações, aparece "medindo a taxa": até lá vale o ajuste do dia.',
      'O cartão "Rodízio dos robôs" mostra a conta. "Robôs por livre" escolhido à mão vale até virar o dia.',
    ],
  },
  {
    id: 'ura-cheia',
    titulo: 'URA cheia',
    onde: 'Aba URA e robôs → "Ligar a URA cheia"',
    itens: [
      'Ligada, qualquer operador do Ativo que atender uma ligação sobe para a URA, sem olhar meta, venda ou fixo.',
      'Ninguém sobe só por estar no Ativo: quem está ocioso lá fica até atender.',
      'A regra do ocioso continua: quem fica livre 2 minutos seguidos na URA volta ao Ativo.',
      'Vale até desligar ou até virar o dia. A URA cheia não liga robô.',
      'Com a URA calma e a URA cheia ligada ao mesmo tempo: a URA fica com 4 a 6 humanos livres (fixos contam). Faltando, sobem os mais antigos (ramal menor) livres no Ativo, sem precisar ter atendido; passando de 6, voltam ao Ativo os livres há mais tempo. Quem volta só sobe de novo depois de atender no Ativo.',
    ],
  },
  {
    id: 'status-ura',
    titulo: 'Status da URA (calma, normal, agressiva)',
    onde: 'Visão geral e aba URA e robôs',
    itens: [
      'Automático: o termômetro decide pela espera de quem está livre nos últimos 5 min. Até 60 s é agressiva, de 60 a 120 s é normal, e 120 s ou mais é calma. Um callback nos últimos 5 min deixa agressiva.',
      'Manual: a supervisão escolhe calma, normal ou agressiva, e vale até alguém escolher "Automático" de novo.',
      'Calma: com 1 livre, fixo ou não, os robôs seguem até ele atender ou ir para o Ativo (o pânico não desliga nem reduz).',
    ],
  },
  {
    id: 'todos-no-ativo',
    titulo: 'Alocar todos no Ativo e Retomar rodízio',
    onde: 'Aba Receptivo',
    itens: [
      '"Alocar todos no Ativo" tira da URA todos os humanos que não são fixos e pausa o rodízio: ninguém sobe para a URA, nem quem vender.',
      'A pausa vale até alguém clicar em "Retomar rodízio da URA", mesmo de um dia para o outro. Uma faixa no topo avisa.',
      '"Retomar rodízio da URA" leva na hora para a URA quem vendeu hoje, bateu a meta ontem ou é fixo; os outros seguem no Ativo.',
    ],
  },
  {
    id: 'atendente',
    titulo: 'Ações por atendente',
    onde: 'Aba Receptivo → menu ⋮ de cada atendente',
    itens: [
      'Pausar (os tipos vêm da Argus), Sair da pausa, Ficar disponível e Deslogar (pede confirmação).',
      'Mandar para o Ativo ou Trazer para a URA. Quem é movido à mão fica travado onde foi posto até "Liberar para o rodízio" ou até virar o dia.',
      'Embaixo do status de cada livre na URA: "sai em 0:45" é quanto falta para voltar ao Ativo (2 min mais a antiguidade). Se ele não sai, aparece o motivo: fixo, travado à mão, conta de supervisor ou sem grupo do Ativo (neste caso, defina o grupo do supervisor dele).',
      'Só vale para humanos da URA ou do Ativo. Cada ação fica no log com quem pediu.',
    ],
  },
  {
    id: 'relatorio',
    titulo: 'Relatório do dia (as siglas)',
    onde: 'Visão geral → Relatório do dia (e a aba Relatórios)',
    itens: [
      'Transbordos: os callbacks ("Gerou Callback" da Argus). O cliente pediu um humano, esperou na fila e desistiu ou estourou o tempo.',
      'Leads derivados: ligações dos robôs que a Argus passou para um humano.',
      'TME (Tempo Médio de Espera): quanto tempo, em média, cada operador ficou livre antes de receber uma ligação.',
      'OPL (Ociosidade Por Lead): o tempo livre de todos somado, dividido pelas ligações. Alto quer dizer gente demais livre para as ligações que chegam.',
      'TOR (Tempo Ocioso sem Robô): tempo com alguém livre na URA e todos os robôs desligados, o que o pânico custa.',
      'TPA (Tempo de Pânico Ativo): tempo em que o BenURA estava desligando ou reduzindo os robôs.',
      'Embaixo de cada quadro: o dia anterior e a média dos últimos 7 dias. Verde com ▼ quando hoje está melhor (menor), vermelho com ▲ quando está pior. O dia de hoje ainda não acabou, então compare com calma.',
      'Na tabela por hora, "mais ociosa" marca a hora com o OPL mais alto (mais tempo livre por lead), se passar de 3 min. A coluna de status (Calma, Normal ou Agressiva) segue o status da URA de agora.',
      'Cor de cada quadro: verde está bom, amarelo pede atenção, vermelho está ruim. Transbordos: 0 verde, até 5 amarelo. TOR: até 5 min verde, até 15 amarelo. TME: até 2 min verde, até 4 amarelo. OPL: até 3 min verde, até 5 amarelo. TPA: até 10 min verde, até 30 amarelo.',
      'A barra embaixo dos quadros mostra o status da URA hora a hora (agressiva, normal, calma, medindo). Clicar no status da URA do relatório troca o status, como o seletor da aba URA e robôs.',
      'Só conta o expediente (08:00 às 18:00). O botão "Planilha" baixa o relatório em Excel: hora a hora, comparação e por atendente.',
    ],
  },
  {
    id: 'periodo',
    titulo: 'Relatório de 7 e 30 dias e as sugestões',
    onde: 'Relatórios → 7 dias e 30 dias',
    itens: [
      'A Visão geral mostra só o relatório de hoje. A aba Relatórios tem tudo: hoje, 7 dias e 30 dias (com a Planilha), os livres e os robôs ao longo do dia, os callbacks de hoje e as vendas e filas do roteador.',
      'As abas 7 dias e 30 dias mostram um dia por linha, com hoje ainda parcial. A coluna de status segue o status da URA de agora, e "mais ocioso" marca o dia com o OPL mais alto.',
      'Nos quadros, TOR, TPA e transbordos aparecem em média por dia completo, para usar as mesmas cores do relatório do dia (hoje, ainda parcial, não entra na média). TME e OPL somam o período. Embaixo, a comparação com os 7 (ou 30) dias anteriores.',
      'Sugestões: comparam a configuração atual dos robôs com a anterior, em cada status da URA, pelo OPL e pelos transbordos por hora. Só contam as horas daquele status com os robôs no automático (sem robôs por livre escolhido à mão), em dias completos com 2 h ou mais nele, e só com 3 dias ou mais de cada configuração.',
      'A configuração inclui o cálculo (taxa ou fixo), os robôs por livre, a espera alvo e, na calma, o "todos com N livres". Dia em que ela mudou no meio (reinício com outro .env) não entra.',
      'Se o OPL melhorou mas os transbordos subiram mais de 30%, a sugestão avisa e não aponta vencedor. Com 2 semanas de dados (das últimas 8), ela mostra também o dia da semana mais ocioso. As sugestões usam todo o histórico, não só os dias da aba.',
      'As sugestões só sugerem: quem muda os números é a supervisão, no .env. A "Planilha" da aba baixa por dia, os totais com o período anterior e por atendente.',
      '"Ver tendência dia a dia" (logo abaixo dos quadros) abre um gráfico de um indicador por vez: OPL, transbordos, TME ou leads. A linha verde marca o fim da faixa verde. Fechado, não ocupa a tela; o navegador lembra se você deixou aberto.',
      'Nos 30 dias, a tabela mostra os 10 dias mais recentes; "Ver todos" mostra o resto. O total é sempre do período inteiro. No celular, cada linha das tabelas do relatório vira um cartão.',
      '"Ver mapa de risco dos robôs": para cada tanto de gente livre (0, 1, 2, 3, 4 ou mais) e de robôs ligados, quantos callbacks de fila houve por lead. A meta é 1 em 200 (0,5%): verde até ela, âmbar até 1%, vermelho acima, cinza com pouca amostra (menos de 50 ligações). Dá para ver por status da URA. No topo fica o número do período (callbacks de fila a cada 200 leads); toque num quadrinho para ver o detalhe dele. Sem nenhum tocado, "Até onde ficou na meta" diz, para cada tanto de livres, até quantos robôs ficou no verde. Embaixo do número, os callbacks do período separados: de fila (entram no %), invisíveis (havia gente livre; o pontinho roxo no quadrinho mostra onde caíram) e fora do mapa (de antes de ele começar a anotar ou logo depois de um reinício). Os três somam o quadro Transbordos.',
      'Callback com gente livre durante toda a espera do cliente é "invisível" (a ligação não chegou em quem estava livre: telefonia ou Argus). Fica à parte, porque não depende dos robôs. Se os livres foram a 0 em algum momento da espera, é de fila. O tipo é o mesmo do raio-x do callback (o callbacks.txt dos logs). O mapa ainda não muda os robôs: com umas duas semanas de dados, o automático poderá ligar o máximo que fica no verde.',
    ],
  },
  {
    id: 'faixas',
    titulo: 'As faixas do topo',
    onde: 'Topo, em qualquer aba',
    itens: [
      'Vermelhas: pânico ativo, cliente de risco em ligação, automação desligada.',
      'Amarelas: rodízio pausado (todos no Ativo), robôs desligados pelo painel, um componente desligado à mão, serviço fora do ar, token da Argus recusado, rodízio sem falar com a Argus.',
      'Cada faixa diz o que fazer para voltar ao normal.',
      'As abas ficam no botão ao lado da logo: ele mostra a aba atual e, ao clicar, abre a lista com todas. As teclas 1 a 7 trocam de aba.',
    ],
  },
  {
    id: 'desligar',
    titulo: 'Desligar automação, componentes e simulação',
    onde: 'Topo (o botão vermelho redondo com o símbolo de desligar) e aba Serviços',
    itens: [
      'Desligar automação (só administrador, pede para digitar DESLIGAR): desliga os robôs primeiro e depois para o roteador, o rodízio e as rotinas. Continua desligada mesmo se o PC reiniciar, até "Religar automação".',
      'Cada componente sozinho (cartão dele na aba Serviços): "Desligar" para só o roteador, só o rodízio ou só as rotinas; "Ligar o …" volta. Desligar o rodízio desliga os robôs antes, e sem ele não há pânico nem rodízio.',
      'O "Religar automação" e a agenda das 08:00 não religam quem foi desligado à mão.',
      'Modo simulação: o BenURA continua lendo a Argus e mostra o que faria, mas não move ninguém nem mexe nos robôs.',
    ],
  },
  {
    id: 'servicos-separados',
    titulo: 'Rodízio de pessoas e serviço dos robôs',
    onde: 'Aba Serviços (cartões "Rodízio de pessoas" e "Robôs da URA")',
    itens: [
      'São dois serviços: o rodízio de pessoas (benura-rodizio) move quem sobe e volta da URA; o serviço dos robôs (benura-robos) liga e desliga os robôs (pânico, modo, ajuste, cliente de risco). Um problema num não para o outro.',
      'O rodízio de pessoas manda a foto da URA aos robôs a cada ciclo e na hora de cada atendimento: os robôs reagem tão rápido quanto antes, e a Argus não recebe consultas a mais.',
      'Rodízio de pessoas desligado: quem está na URA fica onde está, ninguém sobe nem volta. Os robôs seguem, lendo a URA sozinhos.',
      'Serviço dos robôs desligado (ou sem responder por 30 s): os robôs parados param de discar e os em ligação terminam a chamada. As pessoas seguem no rodízio normal.',
      'Para voltar a ter tudo num serviço só: ROBOS_SERVICO_PROPRIO=false no .env e reiniciar o rodízio.',
    ],
  },
  {
    id: 'avisos',
    titulo: 'Avisos (BenHub)',
    onde: 'Aba Serviços → Avisos (BenHub)',
    itens: [
      'O painel avisa quando o roteador, o rodízio ou as rotinas ficam mais de 5 min fora do ar, e quando voltam.',
      'Às 18:00, antes de desligar, manda o resumo do dia: transbordos, leads derivados, TME, OPL, TOR e TPA, com o dia anterior e a semana.',
      'Os avisos ficam sempre no log de hoje. Com o BenHub configurado, também chegam lá. "Testar envio" confere.',
      'Webhook de transferências: sistemas cadastrados recebem um aviso (código da Argus, nome e "Transferido da URA para o Ativo" ou o contrário) a cada operador transferido. No cartão "Clientes do webhook de transferências" o administrador cadastra (nome e endereço; o segredo aparece uma vez só, para passar ao cliente), testa e remove. O cliente também pode se cadastrar por API.',
      'Alertas da operação: OPL dos últimos 15 min acima de 5 min por lead (gente demais livre) e mais de 10 min na última hora com gente livre e todos os robôs desligados (TOR). Avisam uma vez; o OPL avisa também quando normaliza.',
    ],
  },
  {
    id: 'papeis',
    titulo: 'Quem pode o quê',
    onde: 'Aba Serviços → Usuários',
    itens: [
      'Visualização: só vê as telas.',
      'Supervisor: opera o dia (atendentes, robôs, status da URA, pânico, URA cheia, todos no Ativo, esteira).',
      'Administrador: tudo, inclusive desligar automação e componentes, simulação, configuração em uso, avisos e usuários.',
    ],
  },
  {
    id: 'problemas',
    titulo: 'Algo deu errado?',
    onde: 'Aba Serviços',
    itens: [
      'Veja os "Avisos de hoje" no fim da aba Serviços: cada problema aparece lá com o horário e o serviço.',
      'Serviço fora do ar: no PC do BenURA, "npx pm2 status" mostra quem caiu e "npx pm2 logs" mostra o motivo.',
      'É a Argus ou o BenURA? O cartão "Argus (discadora)" na aba Serviços mostra as chamadas dos últimos 15 min: quantas deram erro, o tempo médio, as lentas e os pedidos para desacelerar (HTTP 429). Muitos erros ou pedidos para desacelerar = o problema está na Argus (ou na rede até ela), e uma faixa amarela avisa no topo.',
      'Robôs ligados sem ninguém livre na URA: desligue pelo painel da Argus e confira se o pânico está ligado (aba URA e robôs).',
      'Em emergência, "Desligar automação" para tudo sem mexer em mais nada.',
    ],
  },
];

const normalizar = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** As seções que têm o termo no título, no "onde" ou nos itens (sem acento nem maiúscula). */
export function filtrarAjuda(termo: string, secoes: SecaoDaAjuda[] = SECOES_DA_AJUDA): SecaoDaAjuda[] {
  const t = normalizar(termo.trim());
  if (!t) return secoes;
  return secoes.filter((s) => normalizar([s.titulo, s.onde, ...s.itens].join(' ')).includes(t));
}
