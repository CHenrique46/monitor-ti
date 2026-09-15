import test from 'node:test'
import assert from 'node:assert/strict'
import { markerKey, requestMarker, shouldNotify } from '../src/pendingRequests.js'

const first = { pendentes: 1, ultimaSolicitacaoId: 10, ultimaSolicitacaoEm: '2026-09-15T01:00:00.000Z' }
const second = { pendentes: 2, ultimaSolicitacaoId: 11, ultimaSolicitacaoEm: '2026-09-15T01:01:00.000Z' }

test('estabelece contagem-base sem alerta e alerta uma única nova solicitação', () => {
  assert.equal(shouldNotify(null, first, null, null), false)
  assert.equal(shouldNotify(first.pendentes, second, requestMarker(first), null), true)
  assert.equal(shouldNotify(second.pendentes, second, requestMarker(second), requestMarker(second)), false)
})

test('marcador contém somente id e timestamp técnicos', () => {
  const marker = requestMarker(second)
  assert.equal(markerKey(marker), '11:2026-09-15T01:01:00.000Z')
  assert.deepEqual(Object.keys(marker).sort(), ['id', 'timestamp'])
})
