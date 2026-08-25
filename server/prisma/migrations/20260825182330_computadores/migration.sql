-- CreateTable
CREATE TABLE "Computador" (
    "id" SERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "usuario" TEXT,
    "ip" TEXT,
    "sistema" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "ultimaConexao" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Computador_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Computador_deviceId_key" ON "Computador"("deviceId");
