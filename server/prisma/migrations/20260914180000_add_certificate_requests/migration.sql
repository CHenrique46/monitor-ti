CREATE TABLE "SolicitacaoCertificado" (
    "id" SERIAL NOT NULL,
    "protocolo" TEXT NOT NULL,
    "certificadoId" INTEGER NOT NULL,
    "computadorId" INTEGER NOT NULL,
    "hostnameRegistrado" TEXT,
    "usuarioWindowsRegistrado" TEXT,
    "ipRegistrado" TEXT NOT NULL,
    "motivo" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'PENDENTE',
    "solicitadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analisadoEm" TIMESTAMP(3),
    "analisadoPor" TEXT,
    "motivoNegativa" TEXT,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SolicitacaoCertificado_estado_check" CHECK ("estado" IN ('PENDENTE', 'APROVADA', 'NEGADA')),
    CONSTRAINT "SolicitacaoCertificado_motivo_negativa_check" CHECK ("estado" <> 'NEGADA' OR length(btrim("motivoNegativa")) > 0),
    CONSTRAINT "SolicitacaoCertificado_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SolicitacaoCertificado_protocolo_key" ON "SolicitacaoCertificado"("protocolo");
CREATE INDEX "SolicitacaoCertificado_certificadoId_idx" ON "SolicitacaoCertificado"("certificadoId");
CREATE INDEX "SolicitacaoCertificado_computadorId_idx" ON "SolicitacaoCertificado"("computadorId");
CREATE INDEX "SolicitacaoCertificado_estado_idx" ON "SolicitacaoCertificado"("estado");
CREATE INDEX "SolicitacaoCertificado_solicitadoEm_idx" ON "SolicitacaoCertificado"("solicitadoEm");
CREATE INDEX "SolicitacaoCertificado_computadorId_solicitadoEm_idx" ON "SolicitacaoCertificado"("computadorId", "solicitadoEm");
CREATE UNIQUE INDEX "SolicitacaoCertificado_pendente_certificado_computador_key" ON "SolicitacaoCertificado"("certificadoId", "computadorId") WHERE "estado" = 'PENDENTE';
ALTER TABLE "SolicitacaoCertificado" ADD CONSTRAINT "SolicitacaoCertificado_certificadoId_fkey" FOREIGN KEY ("certificadoId") REFERENCES "Certificado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SolicitacaoCertificado" ADD CONSTRAINT "SolicitacaoCertificado_computadorId_fkey" FOREIGN KEY ("computadorId") REFERENCES "Computador"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
