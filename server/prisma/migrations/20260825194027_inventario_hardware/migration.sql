-- AlterTable
ALTER TABLE "Computador" ADD COLUMN     "biosFabricante" TEXT,
ADD COLUMN     "biosVersao" TEXT,
ADD COLUMN     "fabricante" TEXT,
ADD COLUMN     "modeloEquipamento" TEXT,
ADD COLUMN     "numeroSerie" TEXT,
ADD COLUMN     "placaMaeFabricante" TEXT,
ADD COLUMN     "placaMaeModelo" TEXT;

-- CreateTable
CREATE TABLE "DiscoFisico" (
    "id" SERIAL NOT NULL,
    "computadorId" INTEGER NOT NULL,
    "modelo" TEXT,
    "tamanho" DOUBLE PRECISION,
    "interface" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoFisico_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DiscoFisico" ADD CONSTRAINT "DiscoFisico_computadorId_fkey" FOREIGN KEY ("computadorId") REFERENCES "Computador"("id") ON DELETE CASCADE ON UPDATE CASCADE;
