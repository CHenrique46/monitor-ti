import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAgendamentoCreatePayload,
  buildSelectionSummary,
  buildAvisoPayload,
  filterComputersForSelection,
  selectVisibleComputerIds
} from '../src/utils/avisos.js'

const computers = [
  { id: 1, hostname: 'Alpha-PC', usuario: 'Maria', ip: '10.0.0.1', status: 'online', noticesReady: true },
  { id: 2, hostname: 'Beta-Lab', usuario: 'Joao', ip: '10.0.0.2', status: 'offline', noticesReady: false },
  { id: 3, hostname: 'Gamma', usuario: 'Carlos', ip: '10.0.0.3', status: 'online', noticesReady: true }
]

test('busca por hostname', () => {
  const result = filterComputersForSelection(computers, { search: 'alpha' })
  assert.deepEqual(result.map((c) => c.id), [1])
})

test('busca por usuario e ip', () => {
  const byUser = filterComputersForSelection(computers, { search: 'joa' })
  const byIp = filterComputersForSelection(computers, { search: '10.0.0.3' })
  assert.deepEqual(byUser.map((c) => c.id), [2])
  assert.deepEqual(byIp.map((c) => c.id), [3])
})

test('filtro online e offline', () => {
  assert.deepEqual(
    filterComputersForSelection(computers, { statusFilter: 'online' }).map((c) => c.id),
    [1, 3]
  )
  assert.deepEqual(
    filterComputersForSelection(computers, { statusFilter: 'offline' }).map((c) => c.id),
    [2]
  )
})

test('filtro de prontidao', () => {
  assert.deepEqual(
    filterComputersForSelection(computers, { readinessFilter: 'ready' }).map((c) => c.id),
    [1, 3]
  )
  assert.deepEqual(
    filterComputersForSelection(computers, { readinessFilter: 'unready' }).map((c) => c.id),
    [2]
  )
})

test('selecionar visiveis preserva selecao fora do filtro', () => {
  const visible = filterComputersForSelection(computers, { statusFilter: 'online' })
  assert.deepEqual(selectVisibleComputerIds([99, 2], visible), [99, 2, 1, 3])
})

test('limpar selecao zera contagem', () => {
  const summary = buildSelectionSummary(computers, computers, [])
  assert.equal(summary.selected, 0)
  assert.equal(summary.visible, 3)
  assert.equal(summary.total, 3)
})

test('contador e payload usam ids reais selecionados', () => {
  const summary = buildSelectionSummary(computers, computers.slice(0, 2), [1, 2, 3])
  assert.equal(summary.selected, 3)
  assert.equal(summary.visible, 2)
  assert.equal(summary.total, 3)

  const avisoPayload = buildAvisoPayload({ titulo: 'Aviso', mensagem: 'Teste', nivel: 'info', alvoTipo: 'selecionados' }, [1, 2, 3])
  assert.deepEqual(avisoPayload.alvoIds, [1, 2, 3])

  const agendamentoPayload = buildAgendamentoCreatePayload(
    {
      titulo: 'Aviso',
      mensagem: 'Teste',
      nivel: 'info',
      alvoTipo: 'selecionados',
      tipo: 'daily',
      hora: '17:00'
    },
    [1, 2, 3],
    new Date('2026-08-28T15:00:00.000Z')
  )
  assert.deepEqual(agendamentoPayload.payload.alvoIds, [1, 2, 3])
})
