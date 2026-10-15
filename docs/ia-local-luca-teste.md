# Teste de IA local do Luca

## Resultado

O teste do modelo local foi concluido sem integracao ao portal. A previa do
Luca continua usando somente o atendimento guiado e o catalogo sintetico.

Motivos para nao integrar:

- a resposta inicial levou aproximadamente 7,3 s;
- as respostas seguintes levaram de 1,7 s a 5,9 s;
- a RAM livre caiu de aproximadamente 5,13 GiB para 4,1 GiB enquanto o
  modelo estava carregado;
- houve resposta prolixa e sem obedecer ao limite solicitado;
- houve resposta incoerente sobre verificacoes de impressao;
- houve recusa indevida para uma pergunta simples sobre phishing;
- o modelo nao deve substituir o atendimento guiado nem as regras do portal.

O modelo foi descarregado ao final. A RAM livre voltou para aproximadamente
5,22 GiB. O health do HenriTech respondeu HTTP 200 antes, durante e depois
do teste. Nenhum processo do HenriTech foi reiniciado ou alterado.

## Ambiente

- Runtime: Ollama para Windows 0.40.4.
- Modelo: `qwen2.5:1.5b`, somente local.
- Tamanho informado pelo Ollama: 1,1 GB carregado; download de 986 MB.
- Processador: 100% CPU segundo `ollama ps`.
- Contexto: 2048 tokens.
- Paralelismo: 1 geracao por vez.
- Fila: 4 requisicoes.
- API: `127.0.0.1:11434`.
- Cloud: desabilitado com `OLLAMA_NO_CLOUD=1`.
- Firewall: nenhuma regra criada ou alterada.
- Dados: somente perguntas sinteticas em portugues sobre TI.

## Perguntas sinteticas

Foram testados DNS, impressao no Windows, diferenca entre RAM e disco e uma
mensagem solicitando senha. O modelo respondeu em portugues, mas apresentou
artefatos de acentuacao no registro do terminal, excesso de enumeracao e
orientacoes que exigiriam revisao humana.

## Integracao

Nao houve integracao com `CertificateChat` ou com o adaptador de certificados.
Certificados continuam usando catalogo, confirmacao, solicitacao existente e
fallback guiado. Nao houve acesso a Obsidian, execucao de comandos, acao
remota, dado real, mudanca de assunto via IA ou teste de sessoes de IA.

## Fontes oficiais

- https://ollama.com/download/windows
- https://docs.ollama.com/windows
- https://docs.ollama.com/faq
- https://ollama.com/library/qwen2.5:1.5b

O instalador foi obtido pelo instalador oficial `https://ollama.com/install.ps1`
e validado pelo proprio script como assinado por `Ollama Inc.`. Pesos do
modelo e instaladores permanecem fora deste repositorio.
