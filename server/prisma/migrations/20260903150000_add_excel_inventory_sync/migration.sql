CREATE TABLE "ExcelInventorySync" (
    "id" SERIAL NOT NULL,
    "computerId" INTEGER NOT NULL,
    "baselineId" INTEGER NOT NULL,
    "equipamentoNumero" TEXT NOT NULL,
    "operation" TEXT NOT NULL DEFAULT 'UPSERT_INVENTORY',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "ExcelInventorySync_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExcelInventorySync_baselineId_key" ON "ExcelInventorySync"("baselineId");
CREATE UNIQUE INDEX "ExcelInventorySync_baselineId_operation_key" ON "ExcelInventorySync"("baselineId", "operation");
CREATE INDEX "ExcelInventorySync_status_nextAttemptAt_idx" ON "ExcelInventorySync"("status", "nextAttemptAt");
CREATE INDEX "ExcelInventorySync_computerId_idx" ON "ExcelInventorySync"("computerId");
ALTER TABLE "ExcelInventorySync" ADD CONSTRAINT "ExcelInventorySync_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "Computador"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExcelInventorySync" ADD CONSTRAINT "ExcelInventorySync_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "ComputerInventoryBaseline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
