import test from 'node:test'
import assert from 'node:assert/strict'
import {
  filterAvisosHistory,
  groupAvisosHistory,
  historyStatusSummary,
  saoPauloToUtc
} from '../src/utils/avisos.js'

const avisos = [
  { id: 1, titulo: 'Limpeza', nivel: 'info', criadoEm: saoPauloToUtc(2026, 8, 29, 10, 0) },
  { id: 2, titulo: 'Reinício', nivel: 'aviso', criadoEm: saoPauloToUtc(2026, 8, 28, 10, 0) },
  { id: 3, titulo: 'Patch Crítico', nivel: 'urgente', criadoEm: saoPauloToUtc(2026, 8, 20, 10, 0) }
]

const entregas = [
  {
    id: 10,
    avisoId: 1,
    ocorrenciaId: 11,
    titulo: 'Limpeza',
    nivel: 'info',
    estado: 'CONFIRMADO',
    criadoEm: saoPauloToUtc(2026, 8, 29, 10, 5),
    computador: { hostname: 'Alpha-PC', usuario: 'Maria' }
  },
  {
    id: 11,
    avisoId: 2,
    ocorrenciaId: 12,
    titulo: 'Reinício',
    nivel: 'aviso',
    estado: 'ENVIADO',
    criadoEm: saoPauloToUtc(2026, 8, 28, 10, 5),
    computador: { hostname: 'Beta-Lab', usuario: 'Joao' }
  },
  {
    id: 12,
    avisoId: 2,
    ocorrenciaId: 12,
    titulo: 'Reinício',
    nivel: 'aviso',
    estado: 'EXIBIDO',
    criadoEm: saoPauloToUtc(2026, 8, 28, 10, 6),
    computador: { hostname: 'Gamma', usuario: 'Carlos' }
  },
  {
    id: 13,
    avisoId: 2,
    ocorrenciaId: 12,
    titulo: 'Reinício',
    nivel: 'aviso',
    estado: 'CONFIRMADO',
    criadoEm: saoPauloToUtc(2026, 8, 28, 10, 7),
    computador: { hostname: 'Delta', usuario: 'Ana' }
  },
  {
    id: 14,
    avisoId: 3,
    ocorrenciaId: 13,
    titulo: 'Patch Crítico',
    nivel: 'urgente',
    estado: 'PENDENTE',
    criadoEm: saoPauloToUtc(2026, 8, 20, 10, 5),
    computador: { hostname: 'Omega', usuario: 'Paulo' }
  }
]

const history = groupAvisosHistory(avisos, entregas, [])

test('busca por titulo', () => {
  const filtered = filterAvisosHistory(history, { search: 'limpeza' }, saoPauloToUtc(2026, 8, 29, 15, 0))
  assert.deepEqual(filtered.map((h) => h.avisoId), [1])
})

test('busca por hostname e usuario', () => {
  const byHost = filterAvisosHistory(history, { search: 'beta' }, saoPauloToUtc(2026, 8, 29, 15, 0))
  const byUser = filterAvisosHistory(history, { search: 'ana' }, saoPauloToUtc(2026, 8, 29, 15, 0))
  assert.deepEqual(byHost.map((h) => h.avisoId), [2])
  assert.deepEqual(byUser.map((h) => h.avisoId), [2])
})

test('filtro por status', () => {
  assert.deepEqual(
    filterAvisosHistory(history, { status: 'CONFIRMADO' }, saoPauloToUtc(2026, 8, 29, 15, 0)).map((h) => h.avisoId),
    [1]
  )
  assert.deepEqual(
    filterAvisosHistory(history, { status: 'ENVIADO' }, saoPauloToUtc(2026, 8, 29, 15, 0)).map((h) => h.avisoId),
    [2]
  )
})

test('filtro por nivel', () => {
  assert.deepEqual(
    filterAvisosHistory(history, { nivel: 'urgente' }, saoPauloToUtc(2026, 8, 29, 15, 0)).map((h) => h.avisoId),
    [3]
  )
})

test('filtro por periodo', () => {
  const now = saoPauloToUtc(2026, 8, 29, 15, 0)
  assert.deepEqual(filterAvisosHistory(history, { period: 'today' }, now).map((h) => h.avisoId), [1])
  assert.deepEqual(filterAvisosHistory(history, { period: '7d' }, now).map((h) => h.avisoId), [1, 2])
  assert.deepEqual(filterAvisosHistory(history, { period: '30d' }, now).map((h) => h.avisoId), [1, 2, 3])
})

test('status agregado com multiplas entregas', () => {
  const mixed = history.find((h) => h.avisoId === 2)
  assert.equal(mixed.primaryStatus, 'ENVIADO')
  assert.equal(historyStatusSummary(mixed.counts), 'Enviado 1 · Exibido 1 · Confirmado 1')
})

test('ordenacao mais recente primeiro', () => {
  assert.deepEqual(history.map((h) => h.avisoId), [1, 2, 3])
})
