DROP INDEX IF EXISTS "ExcelInventorySync_baselineId_key";
DROP INDEX IF EXISTS "ExcelInventorySync_baselineId_operation_key";
CREATE UNIQUE INDEX "ExcelInventorySync_active_baseline_operation_key"
  ON "ExcelInventorySync"("baselineId", "operation")
  WHERE "status" IN ('PENDING', 'PROCESSING');
