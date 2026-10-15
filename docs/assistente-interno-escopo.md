# Assistente interno HenriTech

## Entrega atual

O portal de certificados agora oferece **Peça para o Luca**, um atendimento
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

## Resultado do teste de IA local

O teste isolado do `qwen2.5:1.5b` foi realizado na NOTE-81, mas não atingiu
qualidade e margem de memória suficientes para integrar a IA ao Luca. O
relatório está em `docs/ia-local-luca-teste.md`. O modelo foi descarregado e a
prévia continua guiada e sintética.

## Próximas etapas

- Dúvidas gerais de TI: reavaliar capacidade e modelo antes de implementar.
- Obsidian: autorizar explicitamente uma pasta Markdown, separar procedimentos
  de conteúdo exclusivo do TI e citar a nota usada como fonte.

Nenhuma dessas capacidades lê ou indexa conteúdo nesta entrega.

## Prévia local sintética

Para abrir a tela com dados sintéticos, iniciar o mock e o dashboard em
terminais separados. O mock escuta somente localhost e não usa PostgreSQL,
SMB ou o serviço de produção:

```powershell
node scripts/preview-certificate-chat.js
cd dashboard
$env:VITE_API_URL = "http://127.0.0.1:4017"
npm.cmd run dev -- --host 127.0.0.1 --port 5174
```

Abrir `http://127.0.0.1:5174/portal/certificados` e clicar no botão flutuante
**Peça para o Luca**, no canto inferior direito. O termo `multi` exercita múltiplos
resultados; `nenhum` exercita resultado vazio. O mock mantém o pedido sintético
em memória e retorna conflito ao repetir a mesma solicitação.

## Fora do escopo

Evolution API, WhatsApp, n8n, contratação de serviços de IA, integração de
modelo local,
indexação automática do Obsidian, aprovação/liberação pelo chat e implantação
em produção.
