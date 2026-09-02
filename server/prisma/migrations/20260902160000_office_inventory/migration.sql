-- CreateTable
CREATE TABLE "OfficeInstallation" (
    "id" SERIAL NOT NULL,
    "computadorId" INTEGER NOT NULL,
    "source" TEXT,
    "productReleaseId" TEXT,
    "productName" TEXT,
    "edition" TEXT,
    "version" TEXT,
    "architecture" TEXT,
    "updateChannel" TEXT,
    "installationTechnology" TEXT,
    "activationStatus" TEXT,
    "rawStatusCode" TEXT,
    "licenseType" TEXT,
    "licenseName" TEXT,
    "licenseDescription" TEXT,
    "partialProductKey" TEXT,
    "fingerprint" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isPresent" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "OfficeInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfficeInstallation_computadorId_fingerprint_key" ON "OfficeInstallation"("computadorId", "fingerprint");

-- CreateIndex
CREATE INDEX "OfficeInstallation_computadorId_isPresent_idx" ON "OfficeInstallation"("computadorId", "isPresent");

-- CreateIndex
CREATE INDEX "OfficeInstallation_computadorId_productReleaseId_idx" ON "OfficeInstallation"("computadorId", "productReleaseId");

-- AddForeignKey
ALTER TABLE "OfficeInstallation" ADD CONSTRAINT "OfficeInstallation_computadorId_fkey" FOREIGN KEY ("computadorId") REFERENCES "Computador"("id") ON DELETE CASCADE ON UPDATE CASCADE;
