import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildAgentUpdateRequest, releaseStatusLabel, selectDefaultAgentRelease, sortAgentReleases } from '../src/utils/agentReleases.js'

const releases = [
  { id: 24, version: '1.1.23', active: true },
  { id: 26, version: '1.1.24', active: false },
  { id: 22, version: '1.1.9', active: false }
]

test('ordena releases semanticamente e seleciona a ativa por padrão', () => {
  assert.deepEqual(sortAgentReleases(releases).map((release) => release.version), ['1.1.24', '1.1.23', '1.1.9'])
  assert.equal(selectDefaultAgentRelease(releases).version, '1.1.23')
  assert.equal(releaseStatusLabel(releases[1]), 'Inativa')
})

test('request de update sempre carrega a versão explícita', () => {
  assert.deepEqual(buildAgentUpdateRequest('1.1.24'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: '1.1.24' })
  })
})

test('seleção e update são controles exclusivos de ADMIN', async () => {
  const source = await readFile(new URL('../src/components/ComputerDetails.jsx', import.meta.url), 'utf8')
  assert.match(source, /isAdmin && releases\.length > 0/)
  assert.match(source, /isAdmin && release && updateAvailable/)
  assert.match(source, /isAdmin && confirm/)
  assert.match(source, /updateRequestInFlight\.current/)
})

test('trocar release não dispara request por si só', async () => {
  const source = await readFile(new URL('../src/components/ComputerDetails.jsx', import.meta.url), 'utf8')
  const selectHandler = source.match(/<select[\s\S]*?onChange=\{\(event\) => setRelease\([\s\S]*?<\/select>/)?.[0]
  assert.ok(selectHandler)
  assert.doesNotMatch(selectHandler, /apiFetch|request\(/)
})

test('update permanece individual e não usa retry automático', async () => {
  const source = await readFile(new URL('../src/components/ComputerDetails.jsx', import.meta.url), 'utf8')
  assert.match(source, /\/agent-update/)
  assert.match(source, /buildAgentUpdateRequest\(release\.version\)/)
  assert.equal((source.match(/await request\('\/agent-update'/g) || []).length, 1)
  assert.equal((source.match(/apiFetch\(`\$\{API_URL\}\/api\/computadores\/\$\{id\}/g) || []).length > 0, true)
})

test('request fica bloqueado durante estado em andamento', async () => {
  const source = await readFile(new URL('../src/components/ComputerDetails.jsx', import.meta.url), 'utf8')
  assert.match(source, /!inProgress && !updateSubmitting/)
  assert.match(source, /disabled=\{disabled\}/)
})
