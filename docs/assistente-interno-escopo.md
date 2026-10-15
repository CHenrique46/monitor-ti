# Luca no portal de certificados

## Objetivo

O portal oferece **Peca para o Luca**, uma camada curta de conversa para dar
personalidade ao mascote e conduzir solicitacoes de certificados. A IA nao e
suporte tecnico e nao diagnostica computadores.

Na previa isolada, o Granite 3.3 2B roda somente no backend do mock. O portal
de producao permanece guiado e sem integracao de IA.

## Papel da IA

- Cumprimentar e responder brevemente a saudacoes e agradecimentos.
- Apresentar-se como Luca, assistente do Escritorio Vava.
- Perguntar qual empresa ou certificado a pessoa procura.
- Entender frases simples e pedir esclarecimento quando necessario.
- Se mencionarem problema de computador, orientar a procurar Henrique do TI,
  sem diagnostico ou comandos.

## Fluxo controlado pelo HenriTech

1. Busca, resultados, validade e situacao vem do catalogo autorizado.
2. Escolha e confirmacao usam os cartoes e botoes existentes.
3. Criacao do pedido usa o servico atual, com prevencao de duplicidade.
4. "Solicitacao enviada" aparece somente apos confirmacao do backend.
5. A IA nao escolhe certificados, aprova pedidos, libera arquivos ou altera
   estados por conta propria.
6. Mudancas de assunto nao confirmam nem cancelam um pedido implicitamente.

A pesquisa tradicional, avatar, permissoes e sessao continuam preservados.

## Implementacao da previa

O adaptador em `dashboard/src/services/certificateChatApi.js` e a fronteira do
atendimento. A variante `certificateChatAiApi.js` so e ativada na previa com
`VITE_LUCA_AI_PREVIEW=true`; ela chama o endpoint conversacional do mock, nunca
o Ollama diretamente pelo navegador.

O mock usa `granite3.3:2b`, com historico curto isolado por `sessionId`, uma
geracao por vez, fila limitada e timeout. Falha ou indisponibilidade retorna
uma mensagem de indisponibilidade e deixa a pesquisa tradicional disponivel,
sem interpretar a mensagem como busca. O modelo recebe o historico recente e o
estado da fase atual, mas nao recebe catalogo, validade,
estado de pedido, credenciais ou dados reais.

O Granite conduz saudacoes, apresentacao, perguntas simples, esclarecimentos e
pedidos de certificado. O frontend intercepta somente controles operacionais
explicitos: confirmacao, correcao/cancelamento e envio pelos botoes existentes.
Nao ha extrator de texto generico para transformar mensagens desconhecidas em
consultas.

O parser aceita JSON estruturado e tambem texto simples ou JSON parcial, sempre
descartando query quando nao ha uma intencao de busca valida. Para reduzir
alucinacao operacional, uma query so e aceita quando seus termos identificaveis
aparecem na mensagem atual do usuario.

## Testes planejados

A previa deve ser avaliada com:

- saudacao;
- pedido de certificado;
- esclarecimento;
- escolha;
- confirmacao e envio;
- agradecimento;
- cancelamento;
- mudanca de assunto durante confirmacao;
- tentativa de duplicidade;
- isolamento entre sessoes.

O roteiro automatizado `node scripts/test-luca-preview.js` executa esse fluxo
contra o Granite instalado e valida resposta conversacional, busca sintetica,
mudanca de assunto, duplicidade, agradecimento, encaminhamento ao TI e
isolamento entre sessoes.

O roteiro `node scripts/test-luca-browser.js` usa Chrome via CDP e valida a
mensagem exata `Oi, Luca, tudo bem?` no navegador. A regressao exige uma
chamada real ao Granite, zero chamadas de busca/criacao do chat e nenhum cartao;
depois confirma que uma conversa casual preserva um cartao pendente. O mock
separa contadores do chat das consultas iniciais da pesquisa tradicional.

### Correcao da saudacao

O caso reproduzido tinha duas causas: a saudacao com o nome do Luca nao era
reconhecida pelo extrator guiado, e o mock retornava Alfa para qualquer texto
desconhecido. Durante a correcao, o cabeçalho `X-Luca-Chat` tambem exigiu
permissao no preflight CORS da previa; sem isso a consulta de um certificado
falhava no navegador. A previa agora normaliza saudacoes, exige uma intencao de
busca e empresa/documento identificavel, retorna vazio para consulta
desconhecida e comprova a chamada do Granite por `graniteCalls`.

### Revisao de capacidade

As frases ineditas testadas mostraram que o Granite conduz bem conversas
curtas, pedidos incompletos e pedidos impossiveis sem criar solicitacoes. Ele
continua inconsistente ao responder perguntas sobre procedimentos internos:
mesmo com instrucao geral para admitir desconhecimento, pode inventar uma
orientacao. Essa limitacao fica registrada e nao foi escondida com novas regras
ou respostas fixas; o modelo continua restrito a esta previa isolada.

## Previa local sintetica

Iniciar o mock e o dashboard em terminais separados:

```powershell
node scripts/preview-certificate-chat.js
cd dashboard
$env:VITE_API_URL = "http://127.0.0.1:4017"
$env:VITE_LUCA_AI_PREVIEW = "true"
npm.cmd run dev -- --host 127.0.0.1 --port 5174
```

Abrir `http://127.0.0.1:5174/portal/certificados` e clicar em **Peca para o
Luca**. O termo `multi` exercita multiplos resultados; `nenhum` exercita
resultado vazio. O mock mantem conversa e pedidos sinteticos em memoria e
retorna conflito ao repetir a mesma solicitacao.

Para validar sem IA, remova `VITE_LUCA_AI_PREVIEW`; o widget usa o fluxo guiado
original.

## Fora do escopo

Suporte tecnico, diagnostico, comandos, Evolution API, WhatsApp, n8n,
contratacao de servicos de IA, indexacao automatica do Obsidian,
aprovacao/liberacao pelo chat e implantacao em producao.
