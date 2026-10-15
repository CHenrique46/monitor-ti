# Assistente interno HenriTech

## Entrega atual

O portal de certificados agora oferece **Peça ao chat**, um atendimento
guiado, sem IA generativa. A conversa:

1. consulta o catálogo autorizado por empresa ou documento;
2. apresenta empresa, documento mascarado, validade e situação;
3. pede escolha quando há mais de um resultado;
4. solicita confirmação explícita;
5. cria a solicitação pelo serviço de portal existente;
6. informa o envio somente após confirmação do backend.

A pesquisa tradicional continua disponível. Sessão, identificação da estação,
permissões, aprovação administrativa, liberação e prevenção de duplicidade
permanecem no backend existente.

O adaptador em `dashboard/src/services/certificateChatApi.js` é a fronteira
substituível do atendimento. O componente recebe `assistantProvider` e usa o
adaptador guiado por padrão; um provedor de IA futuro deverá manter essa
fronteira e nunca receber credenciais no navegador.

## Próximas etapas

- Dúvidas gerais de TI: definir capacidade e autorizações antes de implementar.
- Obsidian: autorizar explicitamente uma pasta Markdown, separar procedimentos
  de conteúdo exclusivo do TI e citar a nota usada como fonte.

Nenhuma dessas capacidades lê ou indexa conteúdo nesta entrega.

## Fora do escopo

Evolution API, WhatsApp, n8n, contratação de serviços de IA, modelo local,
indexação automática do Obsidian, aprovação/liberação pelo chat e implantação
em produção.
