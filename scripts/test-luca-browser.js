const assert = require("assert");
const http = require("http");
const WebSocket = require("../server/node_modules/ws");

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (error) { reject(error); } });
    }).on("error", reject);
  });
}

function cdp(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  return { socket, command };
}

async function evaluate(browser, expression) {
  const result = await browser.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "browser evaluation failed");
  return result.result.value;
}

async function main() {
  const pages = await getJson("http://127.0.0.1:9222/json/list");
  const page = pages.find((item) => item.type === "page" && (item.url.includes(":5174") || item.url === "about:blank"));
  assert.ok(page, "Chrome CDP page not found");
  const browser = cdp(page);
  await new Promise((resolve) => browser.socket.once("open", resolve));
  try {
    await browser.command("Page.enable");
    await browser.command("Page.navigate", { url: "http://127.0.0.1:5174/portal/certificados" });
    await evaluate(browser, "new Promise(resolve => setTimeout(resolve, 1500))");
    const before = await evaluate(browser, "fetch('http://127.0.0.1:4017/api/preview/stats').then(response => response.json())");
    await evaluate(browser, "document.querySelector('.luca-launcher').click(); true");
    await evaluate(browser, "new Promise(resolve => setTimeout(resolve, 100))");
    const result = await evaluate(browser, `(() => {
      const input = document.querySelector('.luca-composer textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, 'Oi, Luca, tudo bem?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.luca-composer').requestSubmit();
      return true;
    })()`);
    assert.equal(result, true);
    await evaluate(browser, "new Promise(resolve => setTimeout(resolve, 5000))");
    const after = await evaluate(browser, "(async () => ({ text: document.querySelector('.luca-history').innerText, cards: document.querySelectorAll('.luca-certificate-card').length, stats: await fetch('http://127.0.0.1:4017/api/preview/stats').then(response => response.json()) }))()");
    assert.ok(after.text.includes("Oi, Luca, tudo bem?"));
    assert.equal(after.cards, 0);
    assert.equal(after.stats.chatCatalogCalls, before.chatCatalogCalls);
    assert.equal(after.stats.chatCreateCalls, before.chatCreateCalls);
    assert.equal(after.stats.conversationCalls, before.conversationCalls + 1);
    assert.equal(after.stats.graniteCalls, before.graniteCalls + 1);
    await evaluate(browser, `(() => {
      const input = document.querySelector('.luca-composer textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, 'A empresa chama Sintetica Alfa e preciso do certificado');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.luca-composer').requestSubmit();
      return true;
    })()`);
    await evaluate(browser, "new Promise(resolve => setTimeout(resolve, 6000))");
    const pending = await evaluate(browser, "(async () => ({ history: document.querySelector('.luca-history').innerText, cards: document.querySelectorAll('.luca-certificate-card').length, stats: await fetch('http://127.0.0.1:4017/api/preview/stats').then(response => response.json()) }))()");
    assert.equal(pending.cards, 1);
    assert.equal(pending.stats.chatCatalogCalls, before.chatCatalogCalls + 1);
    assert.equal(pending.stats.chatCreateCalls, before.chatCreateCalls);
    await evaluate(browser, `(() => {
      const input = document.querySelector('.luca-composer textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, 'Obrigado');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.luca-composer').requestSubmit();
      return true;
    })()`);
    await evaluate(browser, "new Promise(resolve => setTimeout(resolve, 5000))");
    const casualPending = await evaluate(browser, "(async () => ({ cards: document.querySelectorAll('.luca-certificate-card').length, stats: await fetch('http://127.0.0.1:4017/api/preview/stats').then(response => response.json()) }))()");
    assert.equal(casualPending.cards, 1);
    assert.equal(casualPending.stats.chatCatalogCalls, pending.stats.chatCatalogCalls);
    assert.equal(casualPending.stats.chatCreateCalls, pending.stats.chatCreateCalls);
    console.log(JSON.stringify({ message: "Oi, Luca, tudo bem?", history: after.text, before, after, pending, casualPending }, null, 2));
  } finally {
    browser.socket.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
