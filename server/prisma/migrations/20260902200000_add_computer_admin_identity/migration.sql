ALTER TABLE "Computador" ADD COLUMN "apelido" TEXT;
ALTER TABLE "Computador" ADD COLUMN "equipamentoNumero" TEXT;
CREATE UNIQUE INDEX "Computador_equipamentoNumero_key" ON "Computador"("equipamentoNumero");
