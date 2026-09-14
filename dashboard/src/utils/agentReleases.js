import { compareVersions } from './version.js'

export function sortAgentReleases(releases = []) {
  return [...releases].sort((a, b) => compareVersions(b.version, a.version) || Number(b.id) - Number(a.id))
}

export function selectDefaultAgentRelease(releases = []) {
  return releases.find((release) => release.active) || null
}

export function releaseStatusLabel(release) {
  return release?.active ? 'Ativa' : 'Inativa'
}

export function buildAgentUpdateRequest(version) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version })
  }
}
