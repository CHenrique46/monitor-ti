const PRIVATE_RANGES = [
  { first: 0x0a000000, last: 0x0affffff },
  { first: 0xac100000, last: 0xac1fffff },
  { first: 0xc0a80000, last: 0xc0a8ffff }
];

const VIRTUAL_INTERFACE_PATTERN = /hyper[- ]?v|veth|virtualbox|vmware|docker|wsl|loopback|tailscale|zerotier|vpn|wireguard|openvpn/i;
const COMMON_INTERFACE_PATTERN = /ethernet|wi[- ]?fi|wifi|wlan|\b(?:lan|eth|eno|ens|enx|igc|igb)\b/i;

function ipv4ToNumber(address) {
  const octets = String(address).split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return null;
  const values = octets.map(Number);
  if (values.some((value) => value > 255)) return null;
  return (((values[0] * 256) + values[1]) * 256 + values[2]) * 256 + values[3];
}

function isPrivateIPv4(address) {
  const number = ipv4ToNumber(address);
  return number !== null && PRIVATE_RANGES.some(({ first, last }) => number >= first && number <= last);
}

function scoreInterface(name) {
  if (VIRTUAL_INTERFACE_PATTERN.test(name)) return -50;
  if (COMMON_INTERFACE_PATTERN.test(name)) return 30;
  return 0;
}

function selectLanIPv4(networkInterfaces) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(networkInterfaces || {})) {
    for (const iface of addresses || []) {
      if (iface.family !== "IPv4" || !isPrivateIPv4(iface.address)) continue;
      candidates.push({
        address: iface.address,
        name,
        score: 100 + scoreInterface(name)
      });
    }
  }

  candidates.sort((left, right) =>
    right.score - left.score
    || left.address.localeCompare(right.address, "en")
    || left.name.localeCompare(right.name, "en")
  );
  return candidates[0]?.address || null;
}

function preserveLanIPv4(previousAddress, networkInterfaces) {
  return selectLanIPv4(networkInterfaces) || previousAddress || null;
}

module.exports = { isPrivateIPv4, selectLanIPv4, preserveLanIPv4 };
