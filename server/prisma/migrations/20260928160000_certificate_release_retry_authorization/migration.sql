CREATE TABLE "CertificateReleaseRetryAuthorization" (
    "id" TEXT NOT NULL,
    "solicitacaoId" INTEGER NOT NULL,
    "reason" VARCHAR(240) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acquiredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "attemptId" TEXT,
    "errorCode" TEXT,
    "atualizadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CertificateReleaseRetryAuthorization_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CertificadoLiberacaoAuditoria" ADD COLUMN "retryAuthorizationId" TEXT;

CREATE UNIQUE INDEX "CertificateReleaseRetryAuthorization_attemptId_key" ON "CertificateReleaseRetryAuthorization"("attemptId");
CREATE INDEX "CertificateReleaseRetryAuthorization_solicitacaoId_status_idx" ON "CertificateReleaseRetryAuthorization"("solicitacaoId", "status");
CREATE INDEX "CertificateReleaseRetryAuthorization_status_expiresAt_idx" ON "CertificateReleaseRetryAuthorization"("status", "expiresAt");
CREATE INDEX "CertificadoLiberacaoAuditoria_retryAuthorizationId_idx" ON "CertificadoLiberacaoAuditoria"("retryAuthorizationId");
CREATE UNIQUE INDEX "CertificateReleaseRetryAuthorization_active_request_key"
  ON "CertificateReleaseRetryAuthorization"("solicitacaoId")
  WHERE "status" IN ('PENDING', 'ACQUIRED');

ALTER TABLE "CertificateReleaseRetryAuthorization"
  ADD CONSTRAINT "CertificateReleaseRetryAuthorization_solicitacaoId_fkey"
  FOREIGN KEY ("solicitacaoId") REFERENCES "SolicitacaoCertificado"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CertificadoLiberacaoAuditoria"
  ADD CONSTRAINT "CertificadoLiberacaoAuditoria_retryAuthorizationId_fkey"
  FOREIGN KEY ("retryAuthorizationId") REFERENCES "CertificateReleaseRetryAuthorization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
