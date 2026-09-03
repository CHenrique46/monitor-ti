import test from 'node:test'
import assert from 'node:assert/strict'
import { buildInventoryBaselinePayload, canAddInventory } from '../src/utils/inventoryBaseline.js'

test('shows Add to Inventory only when the baseline is absent', () => {
  assert.equal(canAddInventory({ hasBaseline: false }), true)
  assert.equal(canAddInventory({ hasBaseline: true }), false)
  assert.equal(canAddInventory(null), false)
})

test('builds an administrative-only request payload', () => {
  const payload = buildInventoryBaselinePayload({ equipamentoNumero: '77', apelido: 'Sheila' })
  assert.deepEqual(payload, { equipamentoNumero: '77', apelido: 'Sheila' })
  assert.deepEqual(Object.keys(payload).sort(), ['apelido', 'equipamentoNumero'])
})
