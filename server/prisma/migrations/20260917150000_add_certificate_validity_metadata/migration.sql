-- Rollback lógico: manter as colunas nullable e os dados existentes; não remover informações catalogadas.
ALTER TABLE "Certificado"
  ADD COLUMN "validade" TIMESTAMP(3),
  ADD COLUMN "validadeOrigem" TEXT,
  ADD COLUMN "validadeStatus" TEXT;

CREATE INDEX "Certificado_validadeStatus_ativo_idx"
  ON "Certificado"("validadeStatus", "ativo");
