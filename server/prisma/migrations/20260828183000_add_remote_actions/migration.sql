-- CreateTable
CREATE TABLE "AcaoRemotaExecucao" (
    "id" SERIAL NOT NULL,
    "actionExecutionId" TEXT NOT NULL,
    "computadorId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "mensagem" TEXT,
    "erro" TEXT,
    "resultado" JSONB,
    "solicitadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enviadaEm" TIMESTAMP(3),
    "iniciadaEm" TIMESTAMP(3),
    "concluidaEm" TIMESTAMP(3),
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcaoRemotaExecucao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcaoRemotaExecucao_actionExecutionId_key" ON "AcaoRemotaExecucao"("actionExecutionId");

-- CreateIndex
CREATE INDEX "AcaoRemotaExecucao_computadorId_solicitadaEm_idx" ON "AcaoRemotaExecucao"("computadorId", "solicitadaEm");

-- CreateIndex
CREATE INDEX "AcaoRemotaExecucao_computadorId_action_status_idx" ON "AcaoRemotaExecucao"("computadorId", "action", "status");

-- AddForeignKey
ALTER TABLE "AcaoRemotaExecucao" ADD CONSTRAINT "AcaoRemotaExecucao_computadorId_fkey" FOREIGN KEY ("computadorId") REFERENCES "Computador"("id") ON DELETE CASCADE ON UPDATE CASCADE;
