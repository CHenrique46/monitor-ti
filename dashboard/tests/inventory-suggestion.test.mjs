import test from 'node:test'
import assert from 'node:assert/strict'
import { hostnameEquipmentSuggestion } from '../src/utils/inventorySuggestion.js'

test('extrai somente o bloco numérico final do hostname', () => {
  assert.equal(hostnameEquipmentSuggestion('CONT-55'), '55')
  assert.equal(hostnameEquipmentSuggestion('CONT55'), '55')
  assert.equal(hostnameEquipmentSuggestion('dp05'), '05')
  assert.equal(hostnameEquipmentSuggestion('LEGAL-29'), '29')
  assert.equal(hostnameEquipmentSuggestion('DESKTOP-5RDRCDO'), null)
})
