-- CreateTable
CREATE TABLE "Aviso" (
    "id" SERIAL NOT NULL,
    "titulo" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "nivel" TEXT NOT NULL DEFAULT 'info',
    "autor" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Aviso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgendamentoAviso" (
    "id" SERIAL NOT NULL,
    "avisoId" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "diaSemana" INTEGER,
    "agendadoPara" TIMESTAMP(3) NOT NULL,
    "expiraEmHoras" INTEGER NOT NULL DEFAULT 24,
    "alvoTipo" TEXT NOT NULL,
    "alvoIds" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "proximaExecucao" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgendamentoAviso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OcorrenciaAviso" (
    "id" SERIAL NOT NULL,
    "agendamentoId" INTEGER,
    "avisoId" INTEGER NOT NULL,
    "agendadoPara" TIMESTAMP(3) NOT NULL,
    "processado" BOOLEAN NOT NULL DEFAULT false,
    "alvoTipo" TEXT NOT NULL,
    "alvoIds" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OcorrenciaAviso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntregaAviso" (
    "id" SERIAL NOT NULL,
    "ocorrenciaId" INTEGER,
    "avisoId" INTEGER NOT NULL,
    "computadorId" INTEGER NOT NULL,
    "noticeDeliveryId" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "nivel" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'PENDENTE',
    "enviadoEm" TIMESTAMP(3),
    "exibidoEm" TIMESTAMP(3),
    "confirmadoEm" TIMESTAMP(3),
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntregaAviso_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgendamentoAviso_ativo_proximaExecucao_idx" ON "AgendamentoAviso"("ativo", "proximaExecucao");

-- CreateIndex
CREATE INDEX "OcorrenciaAviso_agendadoPara_processado_idx" ON "OcorrenciaAviso"("agendadoPara", "processado");

-- CreateIndex
CREATE UNIQUE INDEX "EntregaAviso_noticeDeliveryId_key" ON "EntregaAviso"("noticeDeliveryId");

-- CreateIndex
CREATE INDEX "EntregaAviso_computadorId_estado_idx" ON "EntregaAviso"("computadorId", "estado");

-- CreateIndex
CREATE INDEX "EntregaAviso_expiraEm_idx" ON "EntregaAviso"("expiraEm");

-- AddForeignKey
ALTER TABLE "AgendamentoAviso" ADD CONSTRAINT "AgendamentoAviso_avisoId_fkey" FOREIGN KEY ("avisoId") REFERENCES "Aviso"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcorrenciaAviso" ADD CONSTRAINT "OcorrenciaAviso_agendamentoId_fkey" FOREIGN KEY ("agendamentoId") REFERENCES "AgendamentoAviso"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcorrenciaAviso" ADD CONSTRAINT "OcorrenciaAviso_avisoId_fkey" FOREIGN KEY ("avisoId") REFERENCES "Aviso"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntregaAviso" ADD CONSTRAINT "EntregaAviso_ocorrenciaId_fkey" FOREIGN KEY ("ocorrenciaId") REFERENCES "OcorrenciaAviso"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntregaAviso" ADD CONSTRAINT "EntregaAviso_avisoId_fkey" FOREIGN KEY ("avisoId") REFERENCES "Aviso"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntregaAviso" ADD CONSTRAINT "EntregaAviso_computadorId_fkey" FOREIGN KEY ("computadorId") REFERENCES "Computador"("id") ON DELETE CASCADE ON UPDATE CASCADE;
