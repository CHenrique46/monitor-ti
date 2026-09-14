CREATE TABLE "Certificado" (
    "id" SERIAL NOT NULL,
    "nomeExibicao" TEXT NOT NULL,
    "nomePesquisaNormalizado" TEXT NOT NULL,
    "documentoNormalizado" TEXT,
    "tipoDocumento" TEXT,
    "extensao" TEXT NOT NULL,
    "pastaLogica" TEXT,
    "anoReferencia" INTEGER,
    "tamanhoBytes" INTEGER NOT NULL,
    "modificadoEm" TIMESTAMP(3) NOT NULL,
    "origemChave" TEXT NOT NULL,
    "metadataStatus" TEXT NOT NULL DEFAULT 'PENDENTE',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Certificado_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Certificado_origemChave_key" ON "Certificado"("origemChave");
CREATE INDEX "Certificado_nomePesquisaNormalizado_idx" ON "Certificado"("nomePesquisaNormalizado");
CREATE INDEX "Certificado_documentoNormalizado_idx" ON "Certificado"("documentoNormalizado");
CREATE INDEX "Certificado_ativo_anoReferencia_idx" ON "Certificado"("ativo", "anoReferencia");
