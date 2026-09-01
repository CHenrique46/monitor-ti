const assert = require("assert");
const fs = require("fs");
const path = require("path");
const service = require("../server/src/services/computadores.service");
const { createComputadoresController } = require("../server/src/controllers/computadores.controller");

function fakeDb(computer, { activeTarget = null, raceOnline = false, deleteError = null } = {}) {
  let findCount = 0;
  let deleteCount = 0;
  const state = computer ? { ...computer } : null;
  const tx = {
    computador: {
      findUnique: async () => {
        findCount += 1;
        if (raceOnline && findCount === 2 && state) state.status = "online";
        return state ? { id: state.id, status: state.status } : null;
      },
      deleteMany: async () => {
        deleteCount += 1;
        if (deleteError) throw deleteError;
        if (!state || state.status !== "offline") return { count: 0 };
        return { count: 1 };
      }
    },
    maintenanceScheduleTarget: {
      findFirst: async () => activeTarget
    }
  };
  return {
    $transaction: async (callback) => callback(tx),
    get findCount() { return findCount; },
    get deleteCount() { return deleteCount; }
  };
}

async function controllerCall(id, db) {
  const controller = createComputadoresController({
    service: { deleteOfflineComputer: (value) => service.deleteOfflineComputer(value, db) }
  });
  const response = { statusCode: null, body: null };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(body) { response.body = body; return body; }
  };
  await controller.deleteComputer({ params: { id } }, res);
  return response;
}

async function main() {
  const offline = { id: 7, status: "offline" };
  let result = await controllerCall("abc", fakeDb(offline));
  assert.equal(result.statusCode, 400, "ID invalido deve retornar 400");

  result = await controllerCall("7", fakeDb(null));
  assert.equal(result.statusCode, 404, "computador inexistente deve retornar 404");

  const onlineDb = fakeDb({ id: 7, status: "online" });
  result = await controllerCall("7", onlineDb);
  assert.equal(result.statusCode, 409, "computador online deve retornar 409");
  assert.equal(onlineDb.deleteCount, 0, "computador online nao pode ser excluido");

  const maintenanceDb = fakeDb(offline, { activeTarget: { scheduleId: 2 } });
  result = await controllerCall("7", maintenanceDb);
  assert.equal(result.statusCode, 409, "target em manutencao ativa deve retornar 409");
  assert.equal(maintenanceDb.deleteCount, 0, "manutencao ativa bloqueia antes do delete");

  const raceDb = fakeDb(offline, { raceOnline: true });
  result = await controllerCall("7", raceDb);
  assert.equal(result.statusCode, 409, "mudanca para online deve retornar 409");
  assert.equal(raceDb.deleteCount, 0, "corrida online deve bloquear antes do delete");

  const successDb = fakeDb(offline);
  result = await controllerCall("7", successDb);
  assert.equal(result.statusCode, 200, "offline sem impedimentos deve retornar 200");
  assert.deepEqual(result.body, { ok: true, computadorId: 7 });
  assert.equal(successDb.deleteCount, 1, "deve executar somente o delete do computador");

  const prismaErrorDb = fakeDb(offline, { deleteError: new Error("database failure") });
  result = await controllerCall("7", prismaErrorDb);
  assert.equal(result.statusCode, 500, "erro Prisma deve retornar resposta segura");
  assert.deepEqual(result.body, { erro: "Não foi possível excluir o computador." });

  const card = fs.readFileSync(path.join(__dirname, "..", "dashboard", "src", "components", "ComputerCard.jsx"), "utf8");
  const dashboard = fs.readFileSync(path.join(__dirname, "..", "dashboard", "src", "components", "Dashboard.jsx"), "utf8");
  const dialog = fs.readFileSync(path.join(__dirname, "..", "dashboard", "src", "components", "DeleteComputerDialog.jsx"), "utf8");
  assert.match(card, /!online && onDelete/);
  assert.match(dashboard, /method: 'DELETE'/);
  assert.match(dialog, /confirmation === 'EXCLUIR'/);
  assert.match(dialog, /Esta ação removerá o computador/);
  console.log("COMPUTER DELETION TESTS: PASS");
}

main().catch((error) => {
  console.error("COMPUTER DELETION TESTS: FAIL", error.stack || error.message);
  process.exit(1);
});
