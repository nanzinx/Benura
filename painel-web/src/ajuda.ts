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
      'O rodízio leva para a URA quem atendeu uma ligação no Ativo e ficou livre, e devolve ao Ativo quem ficou livre na URA por 2 minutos seguidos. O tempo livre é o "Tempo" da Argus.',
      'O BenURA não loga nem desloga humano: só troca de grupo. A telefonia troca quando a pessoa fica livre, com um pequeno atraso da discadora.',
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
    id: 'ura-cheia',
    titulo: 'URA cheia',
    onde: 'Aba URA e robôs → "Ligar a URA cheia"',
    itens: [
      'Ligada, qualquer operador do Ativo que atender uma ligação sobe para a URA, sem olhar meta, venda ou fixo.',
      'Ninguém sobe só por estar no Ativo: quem está ocioso lá fica até atender.',
      'A regra do ocioso continua: quem fica livre 2 minutos seguidos na URA volta ao Ativo.',
      'Vale até desligar ou até virar o dia. A URA cheia não liga robô.',
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
      'Só vale para humanos da URA ou do Ativo. Cada ação fica no log com quem pediu.',
    ],
  },
  {
    id: 'relatorio',
    titulo: 'Relatório do dia (as siglas)',
    onde: 'Visão geral → Relatório do dia',
    itens: [
      'Transbordos: os callbacks ("Gerou Callback" da Argus). O cliente pediu um humano, esperou na fila e desistiu ou estourou o tempo.',
      'Leads derivados: ligações dos robôs que a Argus passou para um humano.',
      'TME (Tempo Médio de Espera): quanto tempo, em média, cada operador ficou livre antes de receber uma ligação.',
      'OPL (Ociosidade Por Lead): o tempo livre de todos somado, dividido pelas ligações. Alto quer dizer gente demais livre para as ligações que chegam.',
      'TOR (Tempo Ocioso sem Robô): tempo com alguém livre na URA e todos os robôs desligados, o que o pânico custa.',
      'TPA (Tempo de Pânico Ativo): tempo em que o BenURA estava desligando ou reduzindo os robôs.',
      'Embaixo de cada quadro: o dia anterior e a média dos últimos 7 dias. O dia de hoje ainda não acabou, então compare com calma.',
      'Só conta o expediente (08:00 às 18:00). O botão "Planilha" baixa o relatório em Excel: hora a hora, comparação e por atendente.',
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
    ],
  },
  {
    id: 'desligar',
    titulo: 'Desligar automação, componentes e simulação',
    onde: 'Topo (Desligar automação) e aba Serviços',
    itens: [
      'Desligar automação (só administrador, pede para digitar DESLIGAR): desliga os robôs primeiro e depois para o roteador, o rodízio e as rotinas. Continua desligada mesmo se o PC reiniciar, até "Religar automação".',
      'Cada componente sozinho (cartão dele na aba Serviços): "Desligar" para só o roteador, só o rodízio ou só as rotinas; "Ligar o …" volta. Desligar o rodízio desliga os robôs antes, e sem ele não há pânico nem rodízio.',
      'O "Religar automação" e a agenda das 08:00 não religam quem foi desligado à mão.',
      'Modo simulação: o BenURA continua lendo a Argus e mostra o que faria, mas não move ninguém nem mexe nos robôs.',
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
