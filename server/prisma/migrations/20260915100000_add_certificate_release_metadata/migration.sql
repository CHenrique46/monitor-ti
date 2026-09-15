ALTER TABLE "SolicitacaoCertificado"
  ADD COLUMN "nomeArquivoLiberado" TEXT,
  ADD COLUMN "liberadoEm" TIMESTAMP(3),
  ADD COLUMN "erroLiberacao" TEXT,
  ADD COLUMN "tentativasLiberacao" INTEGER NOT NULL DEFAULT 0;
