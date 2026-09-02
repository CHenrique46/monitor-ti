CREATE TABLE "ComputerInventoryBaseline" (
    "id" SERIAL NOT NULL,
    "computadorId" INTEGER NOT NULL,
    "equipamentoNumero" TEXT NOT NULL,
    "apelidoEsperado" TEXT,
    "processadorEsperado" TEXT,
    "ramEsperada" DOUBLE PRECISION,
    "armazenamentoEsperado" TEXT,
    "windowsEsperado" TEXT,
    "officeEsperado" TEXT,
    "officePartialKeyEsperada" TEXT,
    "fabricanteModeloEsperado" TEXT,
    "observacoes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'EXCEL_IMPORT',
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComputerInventoryBaseline_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ComputerInventoryBaseline_computadorId_key" ON "ComputerInventoryBaseline"("computadorId");
CREATE UNIQUE INDEX "ComputerInventoryBaseline_equipamentoNumero_key" ON "ComputerInventoryBaseline"("equipamentoNumero");
ALTER TABLE "ComputerInventoryBaseline" ADD CONSTRAINT "ComputerInventoryBaseline_officePartialKeyEsperada_check" CHECK ("officePartialKeyEsperada" IS NULL OR "officePartialKeyEsperada" ~ '^[A-Za-z0-9]{5}$');
ALTER TABLE "ComputerInventoryBaseline" ADD CONSTRAINT "ComputerInventoryBaseline_computadorId_fkey" FOREIGN KEY ("computadorId") REFERENCES "Computador"("id") ON DELETE CASCADE ON UPDATE CASCADE;
