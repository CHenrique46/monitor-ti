function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''))
  return match ? match.slice(1).map(Number) : null
}

export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

export function isVersionNewer(availableVersion, installedVersion) {
  return compareVersions(availableVersion, installedVersion) > 0
}
