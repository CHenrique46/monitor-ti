const test = require("node:test");
const assert = require("node:assert/strict");
const { createPortalController } = require("./src/controllers/portal.controller");
const { createPortalRouter } = require("./src/routes/portal.routes");

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("Luca controller uses the validated portal session station key", async () => {
  let input;
  const controller = createPortalController({ service: {}, lucaService: { converse: async (value) => { input = value; return { reply: "ok", intent: "conversation", query: "", source: "granite" }; } } });
  const res = response();
  await controller.converse({ portalSession: { computerId: 81 }, body: { sessionId: "session-1", message: "Olá", phase: "waiting" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(input, { conversationKey: "81", sessionId: "session-1", message: "Olá", phase: "waiting" });
});

test("Luca route requires the portal session middleware", () => {
  const router = createPortalRouter({ service: {}, humanSession: () => {}, requireAdmin: () => () => {}, lucaService: {} });
  const layer = router.portal.stack.find((item) => item.route?.path === "/luca/conversa");
  assert.ok(layer);
  assert.equal(layer.route.methods.post, true);
  assert.equal(layer.route.stack.length, 2);
});
