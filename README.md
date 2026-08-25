# Monitor TI

Projeto de monitoramento de máquinas Windows para ambiente de escritório (help desk).

## Visão geral

| Componente  | Tecnologia                     | Porta  | Descrição                                         |
|-------------|--------------------------------|--------|---------------------------------------------------|
| `server`    | Node.js + Express + Prisma     | 4000   | Backend central, API REST e futura ponte WebSocket |
| `dashboard` | React + Vite (JavaScript)      | 5173   | Painel web que consome a API do servidor           |
| `agent`     | Node.js                        | —      | Agente instalado nas máquinas monitoradas          |

Banco de dados: **PostgreSQL** (`monitor_ti`), acessado via **Prisma**.

## Pré-requisitos

- Node.js (LTS) + npm
- Git
- PostgreSQL em `127.0.0.1:5432` (banco `monitor_ti`)

## Configuração

### Server

```bash
cd server
npm install
cp .env.example .env   # edite DATABASE_URL com a senha real
npx prisma generate
npm run dev            # sobe em http://localhost:4000
```

Endpoint de saúde: `GET http://127.0.0.1:4000/health` → `{ "status": "ok" }`

### Dashboard

```bash
cd dashboard
npm install
npm run dev            # sobe em http://localhost:5173
```

O dashboard consulta o servidor e exibe `Servidor: Online/Offline`.

### Agent

```bash
cd agent
npm install
npm start             # exibe "Monitor TI Agent iniciado."
```

## Scripts úteis

| Diretório  | Comando          | Ação                                  |
|------------|------------------|---------------------------------------|
| server     | `npm run dev`    | Servidor em modo desenvolvimento      |
| server     | `npm start`      | Servidor (produção simples)           |
| server     | `npx prisma generate` | Gera o Prisma Client            |
| dashboard  | `npm run dev`    | Interface em desenvolvimento (Vite)   |
| dashboard  | `npm run build`  | Build de produção                     |
| agent      | `npm start`      | Inicia o agente                       |

## Status da Fase 2

Estrutura inicial criada. Ainda **não** implementado: WebSocket, coleta de
métricas, cadastro de máquinas, autenticação, comandos remotos.
