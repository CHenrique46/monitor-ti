-- CreateTable
CREATE TABLE "MetricaComputador" (
    "id" SERIAL NOT NULL,
    "computadorId" INTEGER NOT NULL,
    "cpuUso" DOUBLE PRECISION,
    "ramUsoPct" DOUBLE PRECISION,
    "discoUsoPct" DOUBLE PRECISION,
    "ramUsada" DOUBLE PRECISION,
    "ramTotal" DOUBLE PRECISION,
    "discoLivre" DOUBLE PRECISION,
    "discoTotal" DOUBLE PRECISION,
    "coletadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricaComputador_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alerta" (
    "id" SERIAL NOT NULL,
    "computadorId" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "nivel" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "valor" DOUBLE PRECISION,
    "limite" DOUBLE PRECISION,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "iniciadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvidoEm" TIMESTAMP(3),

    CONSTRAINT "Alerta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetricaComputador_computadorId_coletadoEm_idx" ON "MetricaComputador"("computadorId", "coletadoEm");

-- CreateIndex
CREATE INDEX "Alerta_computadorId_ativo_idx" ON "Alerta"("computadorId", "ativo");

-- CreateIndex
CREATE INDEX "Alerta_iniciadoEm_idx" ON "Alerta"("iniciadoEm");

-- AddForeignKey
ALTER TABLE "MetricaComputador" ADD CONSTRAINT "MetricaComputador_computadorId_fkey" FOREIGN KEY ("computadorId") REFERENCES "Computador"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alerta" ADD CONSTRAINT "Alerta_computadorId_fkey" FOREIGN KEY ("computadorId") REFERENCES "Computador"("id") ON DELETE CASCADE ON UPDATE CASCADE;
