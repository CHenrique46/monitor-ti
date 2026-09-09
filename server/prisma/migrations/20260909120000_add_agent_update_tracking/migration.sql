CREATE TABLE "AgentUpdate" (
    "id" SERIAL NOT NULL,
    "computadorId" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "versaoAnterior" TEXT,
    "versaoDestino" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "iniciadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,
    "finalizadoEm" TIMESTAMP(3),
    "iniciadoPor" TEXT NOT NULL,
    "erro" TEXT,
    "releaseId" INTEGER,

    CONSTRAINT "AgentUpdate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentUpdate_deviceId_iniciadoEm_idx" ON "AgentUpdate"("deviceId", "iniciadoEm");
CREATE INDEX "AgentUpdate_computadorId_status_idx" ON "AgentUpdate"("computadorId", "status");
CREATE INDEX "AgentUpdate_status_atualizadoEm_idx" ON "AgentUpdate"("status", "atualizadoEm");
CREATE UNIQUE INDEX "AgentUpdate_active_computador_unique"
  ON "AgentUpdate"("computadorId")
  WHERE "status" IN ('PENDING', 'DOWNLOADING', 'VALIDATING', 'INSTALLING', 'RESTARTING');

ALTER TABLE "AgentUpdate" ADD CONSTRAINT "AgentUpdate_computadorId_fkey"
  FOREIGN KEY ("computadorId") REFERENCES "Computador"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentUpdate" ADD CONSTRAINT "AgentUpdate_releaseId_fkey"
  FOREIGN KEY ("releaseId") REFERENCES "AgentRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;
