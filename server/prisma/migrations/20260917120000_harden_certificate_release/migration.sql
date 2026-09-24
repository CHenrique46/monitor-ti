ALTER TABLE "SolicitacaoCertificado"
  ADD COLUMN "releasedAt" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "statusLiberacao" TEXT NOT NULL DEFAULT 'NAO_LIBERADO';

UPDATE "SolicitacaoCertificado"
SET "statusLiberacao" = 'LEGADO'
WHERE "nomeArquivoLiberado" IS NOT NULL
  AND "releasedAt" IS NULL;

CREATE TABLE "CertificadoLiberacaoAuditoria" (
    "id" SERIAL NOT NULL,
    "evento" TEXT NOT NULL,
    "solicitacaoId" INTEGER NOT NULL,
    "certificadoId" INTEGER NOT NULL,
    "administrador" TEXT,
    "hostnameSolicitante" TEXT,
    "usuarioSolicitante" TEXT,
    "ocorridoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resultado" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    CONSTRAINT "CertificadoLiberacaoAuditoria_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CertificadoLiberacaoAuditoria_solicitacaoId_ocorridoEm_idx"
  ON "CertificadoLiberacaoAuditoria"("solicitacaoId", "ocorridoEm");
CREATE INDEX "CertificadoLiberacaoAuditoria_certificadoId_ocorridoEm_idx"
  ON "CertificadoLiberacaoAuditoria"("certificadoId", "ocorridoEm");
CREATE INDEX "CertificadoLiberacaoAuditoria_evento_ocorridoEm_idx"
  ON "CertificadoLiberacaoAuditoria"("evento", "ocorridoEm");

ALTER TABLE "CertificadoLiberacaoAuditoria"
  ADD CONSTRAINT "CertificadoLiberacaoAuditoria_solicitacaoId_fkey"
  FOREIGN KEY ("solicitacaoId") REFERENCES "SolicitacaoCertificado"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CertificadoLiberacaoAuditoria_certificadoId_fkey"
  FOREIGN KEY ("certificadoId") REFERENCES "Certificado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
