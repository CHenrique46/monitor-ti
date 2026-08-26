-- AlterTable
ALTER TABLE "Computador" ADD COLUMN     "agentVersion" TEXT;

-- CreateTable
CREATE TABLE "AgentRelease" (
    "id" SERIAL NOT NULL,
    "version" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "releaseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRelease_version_key" ON "AgentRelease"("version");

-- CreateIndex
CREATE INDEX "AgentRelease_active_idx" ON "AgentRelease"("active");
