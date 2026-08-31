-- CreateTable
CREATE TABLE "MaintenanceSchedule" (
    "id" SERIAL NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "time" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "targetMode" TEXT NOT NULL DEFAULT 'ALL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaintenanceSchedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MaintenanceScheduleTarget" (
    "scheduleId" INTEGER NOT NULL,
    "computadorId" INTEGER NOT NULL,
    CONSTRAINT "MaintenanceScheduleTarget_pkey" PRIMARY KEY ("scheduleId", "computadorId")
);

CREATE TABLE "MaintenanceScheduleRun" (
    "id" SERIAL NOT NULL,
    "scheduleId" INTEGER NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "targetCount" INTEGER NOT NULL DEFAULT 0,
    "dispatchedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "MaintenanceScheduleRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AcaoRemotaExecucao" ADD COLUMN "scheduleRunId" INTEGER;

CREATE UNIQUE INDEX "MaintenanceScheduleRun_scheduleId_scheduledFor_key" ON "MaintenanceScheduleRun"("scheduleId", "scheduledFor");
CREATE INDEX "MaintenanceSchedule_enabled_idx" ON "MaintenanceSchedule"("enabled");
CREATE INDEX "MaintenanceScheduleTarget_computadorId_idx" ON "MaintenanceScheduleTarget"("computadorId");
CREATE INDEX "MaintenanceScheduleRun_scheduleId_scheduledFor_idx" ON "MaintenanceScheduleRun"("scheduleId", "scheduledFor");
CREATE UNIQUE INDEX "AcaoRemotaExecucao_scheduleRunId_computadorId_key" ON "AcaoRemotaExecucao"("scheduleRunId", "computadorId");

ALTER TABLE "MaintenanceScheduleTarget" ADD CONSTRAINT "MaintenanceScheduleTarget_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "MaintenanceSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaintenanceScheduleTarget" ADD CONSTRAINT "MaintenanceScheduleTarget_computadorId_fkey" FOREIGN KEY ("computadorId") REFERENCES "Computador"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaintenanceScheduleRun" ADD CONSTRAINT "MaintenanceScheduleRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "MaintenanceSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcaoRemotaExecucao" ADD CONSTRAINT "AcaoRemotaExecucao_scheduleRunId_fkey" FOREIGN KEY ("scheduleRunId") REFERENCES "MaintenanceScheduleRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
