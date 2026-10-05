const test = require("node:test");
const assert = require("node:assert/strict");
const { ALLOWED_POLICY, LEGACY_POLICY, MODERN_POLICY, ORIGIN, ensureBrowserNotificationPolicies } = require("./src/browserNotificationPolicy");

function fakeRegistry({ policies = {}, ownership = null, fail = {} } = {}) {
  const state = { policies: structuredClone(policies), ownership, writes: [], deletes: [] };
  return {
    state,
    readPolicy(name) {
      if (fail.readPolicy) return { ok: false, error: "READ_DENIED" };
      return { ok: true, exists: !!state.policies[name], values: { ...(state.policies[name] || {}) } };
    },
    writePolicyValue(name, index, value) {
      if (fail.writePolicy === name || fail.writePolicy === true) return { ok: false, error: "WRITE_DENIED" };
      state.policies[name] = { ...(state.policies[name] || {}), [index]: value }; state.writes.push({ name, index, value }); return { ok: true };
    },
    deletePolicyValue(name, index) { if (fail.deletePolicy === name || fail.deletePolicy === true) return { ok: false, error: "DELETE_DENIED" }; if (state.policies[name]) delete state.policies[name][index]; state.deletes.push({ name, index }); return { ok: true }; },
    readOwnership() { if (fail.readOwnership) return { ok: false, error: "READ_DENIED" }; return { ok: true, state: state.ownership }; },
    writeOwnership(next) { if (fail.writeOwnership) return { ok: false, error: "WRITE_DENIED" }; state.ownership = next; return { ok: true }; }
  };
}

test("políticas modernas ausentes são criadas e origem é reutilizada sem duplicação", () => { const registry = fakeRegistry({ policies: { [ALLOWED_POLICY]: { "3": "https://terceiro.example" } } }); assert.equal(ensureBrowserNotificationPolicies({ registry }).valid, true); assert.equal(registry.state.policies[MODERN_POLICY]["1"], ORIGIN); assert.equal(registry.state.policies[ALLOWED_POLICY]["1"], ORIGIN); });
test("política moderna existente, origem em outro índice e múltiplos índices são preservados", () => { const registry = fakeRegistry({ policies: { [MODERN_POLICY]: { "2": ORIGIN, "4": "https://other.example" }, [ALLOWED_POLICY]: { "1": "https://one.example", "4": ORIGIN, "7": "https://seven.example" } } }); assert.equal(ensureBrowserNotificationPolicies({ registry }).valid, true); assert.deepEqual(registry.state.policies[MODERN_POLICY], { "2": ORIGIN, "4": "https://other.example" }); });
test("execução duplicada é idempotente", () => { const registry = fakeRegistry(); assert.equal(ensureBrowserNotificationPolicies({ registry }).valid, true); const writes = registry.state.writes.length; assert.equal(ensureBrowserNotificationPolicies({ registry }).valid, true); assert.equal(registry.state.writes.length, writes); });
test("política antiga própria da 1.1.26 é migrada", () => { const registry = fakeRegistry({ policies: { [LEGACY_POLICY]: { "5": ORIGIN } }, ownership: { schema: 1, createdByVersion: "1.1.26", entries: [{ policy: LEGACY_POLICY, index: "5", value: ORIGIN }] } }); assert.equal(ensureBrowserNotificationPolicies({ registry }).legacyMigrated, true); assert.equal(registry.state.policies[LEGACY_POLICY]["5"], undefined); });
test("política antiga sem ownership ou de terceiro é preservada", () => { for (const ownership of [null, { schema: 1, createdByVersion: "third-party", entries: [{ policy: LEGACY_POLICY, index: "1", value: ORIGIN }] }]) { const registry = fakeRegistry({ policies: { [LEGACY_POLICY]: { "1": ORIGIN } }, ownership }); assert.equal(ensureBrowserNotificationPolicies({ registry }).valid, true); assert.equal(registry.state.policies[LEGACY_POLICY]["1"], ORIGIN); } });
test("rollback é seletivo quando a segunda escrita falha", () => { const registry = fakeRegistry({ fail: { writePolicy: ALLOWED_POLICY } }); assert.equal(ensureBrowserNotificationPolicies({ registry }).valid, false); assert.deepEqual(registry.state.policies[MODERN_POLICY], {}); });
test("acesso negado não anuncia capability e não lança", () => { const registry = fakeRegistry({ fail: { readPolicy: true } }); const result = ensureBrowserNotificationPolicies({ registry }); assert.equal(result.valid, false); assert.equal(result.capability, null); });
test("adapter usa explicitamente a view Registry64", () => { const calls = []; const { createRegistry64Adapter } = require("./src/browserNotificationPolicy"); const adapter = createRegistry64Adapter({ platform: "win32", execFileSync: (_file, args) => { calls.push(args.at(-1)); const script = args.at(-1); if (script.includes("BrowserNotificationPolicyOwnership")) return JSON.stringify({ ok: true, raw: null }); if (script.includes("GetValueNames")) return JSON.stringify({ ok: true, exists: true, values: {} }); return JSON.stringify({ ok: true }); } }); adapter.readPolicy(MODERN_POLICY); adapter.readOwnership(); assert.equal(calls.every((script) => script.includes("Registry64")), true); });
