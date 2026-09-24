ALTER TABLE "SolicitacaoCertificado"
  ADD COLUMN "releaseAttemptId" TEXT,
  ADD COLUMN "releaseStartedAt" TIMESTAMP(3),
  ADD COLUMN "releaseStage" TEXT,
  ADD COLUMN "releaseFingerprint" TEXT;

CREATE UNIQUE INDEX "SolicitacaoCertificado_releaseAttemptId_key"
  ON "SolicitacaoCertificado"("releaseAttemptId");
