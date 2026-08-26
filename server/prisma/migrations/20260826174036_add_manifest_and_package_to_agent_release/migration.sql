-- AlterTable
ALTER TABLE "AgentRelease" ADD COLUMN     "manifest" JSONB,
ADD COLUMN     "packageName" TEXT,
ADD COLUMN     "packageSha256" TEXT,
ADD COLUMN     "packageSize" INTEGER;
