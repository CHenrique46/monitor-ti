const test = require("node:test");
const assert = require("node:assert/strict");
const { isPrivateIPv4, selectLanIPv4, preserveLanIPv4 } = require("./src/network");

function ipv4(address, extra = {}) {
  return { address, family: "IPv4", internal: false, ...extra };
}

test("seleciona IPv4 RFC1918 da Ethernet", () => {
  assert.equal(selectLanIPv4({ Ethernet: [ipv4("192.168.40.18")] }), "192.168.40.18");
});

test("prefere Wi-Fi comum ao Hyper-V", () => {
  assert.equal(selectLanIPv4({
    "Wi-Fi": [ipv4("192.168.40.25")],
    "vEthernet (Default Switch)": [ipv4("172.20.0.1")]
  }), "192.168.40.25");
});

test("prefere Ethernet comum à VPN", () => {
  assert.equal(selectLanIPv4({
    VPN: [ipv4("10.8.0.2")],
    Ethernet: [ipv4("192.168.40.30")]
  }), "192.168.40.30");
});

test("prefere Wi-Fi comum ao Docker", () => {
  assert.equal(selectLanIPv4({
    Docker: [ipv4("172.17.0.1")],
    "Wi-Fi": [ipv4("192.168.40.31")]
  }), "192.168.40.31");
});

test("não usa IPv4 público como fallback", () => {
  assert.equal(selectLanIPv4({ Ethernet: [ipv4("54.232.189.113")] }), null);
});

test("não usa endereço link-local como fallback", () => {
  assert.equal(selectLanIPv4({ Ethernet: [ipv4("169.254.20.10")] }), null);
});

test("empate entre interfaces comuns é determinístico", () => {
  const interfaces = {
    Ethernet: [ipv4("192.168.40.42")],
    "Wi-Fi": [ipv4("192.168.40.25")]
  };
  assert.equal(selectLanIPv4(interfaces), "192.168.40.25");
  assert.equal(selectLanIPv4({ "Wi-Fi": interfaces["Wi-Fi"], Ethernet: interfaces.Ethernet }), "192.168.40.25");
});

test("ignora IPv6 e seleciona IPv4 RFC1918", () => {
  assert.equal(selectLanIPv4({ Ethernet: [{ address: "2001:db8::1", family: "IPv6" }, ipv4("192.168.40.50")] }), "192.168.40.50");
});

test("seleciona privado em interface desconhecida", () => {
  assert.equal(selectLanIPv4({ "Unknown Adapter": [ipv4("10.20.30.40")] }), "10.20.30.40");
});

test("reconhece somente RFC1918 como privado", () => {
  assert.equal(isPrivateIPv4("10.0.0.1"), true);
  assert.equal(isPrivateIPv4("172.16.0.1"), true);
  assert.equal(isPrivateIPv4("172.32.0.1"), false);
  assert.equal(isPrivateIPv4("192.168.255.254"), true);
  assert.equal(isPrivateIPv4("127.0.0.1"), false);
  assert.equal(isPrivateIPv4("0.0.0.0"), false);
});

test("preserva ultimo IPv4 privado quando nenhuma interface estiver disponivel", () => {
  assert.equal(preserveLanIPv4("192.168.40.77", {}), "192.168.40.77");
  assert.equal(preserveLanIPv4("54.232.189.113", {}), null);
  assert.equal(preserveLanIPv4("192.168.40.77", { Ethernet: [ipv4("192.168.40.78")] }), "192.168.40.78");
  assert.equal(preserveLanIPv4(null, {}), null);
});
