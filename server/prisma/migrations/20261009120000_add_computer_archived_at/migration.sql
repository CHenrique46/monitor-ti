-- Additive archive marker; existing online/offline status remains unchanged.
ALTER TABLE "Computador" ADD COLUMN "arquivadoEm" TIMESTAMP(3);

CREATE INDEX "Computador_arquivadoEm_idx" ON "Computador"("arquivadoEm");
