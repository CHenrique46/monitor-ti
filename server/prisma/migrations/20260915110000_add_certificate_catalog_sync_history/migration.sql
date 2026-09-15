CREATE TABLE "SincronizacaoCatalogoCertificado" (
    "id" SERIAL NOT NULL,
    "origemCategoria" TEXT NOT NULL DEFAULT 'CLIENTE',
    "gatilho" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "iniciadaEm" TIMESTAMP(3) NOT NULL,
    "finalizadaEm" TIMESTAMP(3),
    "encontrados" INTEGER NOT NULL DEFAULT 0,
    "criados" INTEGER NOT NULL DEFAULT 0,
    "atualizados" INTEGER NOT NULL DEFAULT 0,
    "inativados" INTEGER NOT NULL DEFAULT 0,
    "ignorados" INTEGER NOT NULL DEFAULT 0,
    "erros" INTEGER NOT NULL DEFAULT 0,
    "mensagemSegura" TEXT,
    "executadoPor" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SincronizacaoCatalogoCertificado_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SincronizacaoCatalogoCertificado_origemCategoria_iniciadaEm_idx" ON "SincronizacaoCatalogoCertificado"("origemCategoria", "iniciadaEm");
CREATE INDEX "SincronizacaoCatalogoCertificado_status_iniciadaEm_idx" ON "SincronizacaoCatalogoCertificado"("status", "iniciadaEm");
