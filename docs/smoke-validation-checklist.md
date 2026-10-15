# Checklist de validação smoke

Proposta para execução manual em ambiente de desenvolvimento ou homologação. Este documento não registra testes executados nem autoriza ações em máquinas de produção.

## Preparação

- Registrar SHA/versão do servidor, dashboard e agente, sistema operacional e configuração usada (sem senhas, tokens ou dados pessoais).
- Usar banco e máquina Windows de teste, com autorização para instalar o agente e executar os cenários escolhidos.
- Confirmar com o mantenedor os passos de inicialização e credenciais de teste. O README descreve a estrutura inicial; conferir também os scripts atuais de cada package.json.

## Cenários propostos

| ID | Verificação | Resultado esperado / critério |
| --- | --- | --- |
| SM-01 | Iniciar servidor com configuração válida e consultar GET /health. | Registrar status HTTP e corpo; comparar com o contrato em server/src/controllers/health.controller.js. Não presumir que esse endpoint valida o banco. |
| SM-02 | Executar npm run build no diretório dashboard. | Comando termina com código 0 e gera o build; não confundir com npm run build:production do server. |
| SM-03 | Abrir o dashboard e concluir o fluxo de autenticação com usuário de teste. | Confirmar com o mantenedor a página inicial esperada e os perfis autorizados. |
| SM-04 | Consultar GET /api/computadores sem sessão, em cliente sem cookies. | A API não expõe a lista protegida; confirmar status e corpo esperados no middleware de autenticação. |
| SM-05 | Conectar um agente de teste e depois interrompê-lo. | Confirmar com o mantenedor os indicadores de conexão e o tempo limite de transição para offline; registrar ambos. |
| SM-06 | Atualizar o dashboard e repetir uma consulta após reiniciar o servidor de teste. | Confirmar recuperação da interface e comportamento esperado da sessão; registrar erros de rede e console. |

## Evidência por execução

| Campo | Valor |
| --- | --- |
| Data, responsável e ambiente | Preencher |
| SHA/versões | Preencher |
| Cenário e passos efetivamente executados | Preencher |
| Resultado esperado e observado | Preencher |
| Status | Não executado / passou / falhou / bloqueado |
| Evidência sanitizada ou issue relacionada | Preencher |

## Complementação pelo mantenedor

Antes de tratar o checklist como critério de aceite, preencher os resultados específicos de autenticação, presença/offline e recuperação de sessão, com base no ambiente de teste. Nenhum cenário foi executado durante a elaboração desta proposta.
