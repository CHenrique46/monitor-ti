import assert from 'node:assert/strict'
import test from 'node:test'
import { activationStatus, licenseType, normalizeOffice, partialKey } from '../src/utils/office.js'

const installation = (overrides = {}) => ({
  productName: 'Microsoft 365 Apps',
  version: '16.0.1',
  activationStatus: 'LICENSED',
  licenseType: 'SUBSCRIPTION',
  partialProductKey: 'ABCDE',
  ...overrides
})

test('API antiga sem office vira estado desconhecido', () => {
  assert.deepEqual(normalizeOffice(undefined), { available: null, inventoryStatus: 'unknown', installations: [] })
})

test('office vazio permanece desconhecido, não Office não instalado', () => {
  const result = normalizeOffice({ available: null, installations: [] })
  assert.equal(result.installations.length, 0)
  assert.equal(result.available, null)
})

test('uma instalação Microsoft 365 é preservada', () => {
  assert.equal(normalizeOffice({ installations: [installation()] }).installations[0].productName, 'Microsoft 365 Apps')
})

test('Office LTSC é preservado', () => {
  assert.equal(normalizeOffice({ installations: [installation({ productName: 'Office LTSC' })] }).installations[0].productName, 'Office LTSC')
})

test('status de ativação é traduzido', () => {
  assert.equal(activationStatus('LICENSED').label, 'Licenciado')
  assert.equal(activationStatus('UNLICENSED').label, 'Não licenciado')
  assert.equal(activationStatus('NOTIFICATION').label, 'Requer atenção')
  assert.equal(activationStatus('GRACE').label, 'Período de carência')
  assert.equal(activationStatus('UNKNOWN').label, 'Desconhecido')
})

test('tipo de licença é traduzido sem inferência', () => {
  assert.equal(licenseType('RETAIL'), 'Retail')
  assert.equal(licenseType('VOLUME_KMS'), 'Volume / KMS')
  assert.equal(licenseType('VOLUME_MAK'), 'Volume / MAK')
  assert.equal(licenseType('SUBSCRIPTION'), 'Assinatura')
  assert.equal(licenseType('OTHER'), 'Desconhecido')
})

test('múltiplas instalações não são sobrescritas', () => {
  const result = normalizeOffice({ installations: [installation({ productName: 'M365' }), installation({ productName: 'Visio' }), installation({ productName: 'Project' })] })
  assert.deepEqual(result.installations.map((item) => item.productName), ['M365', 'Visio', 'Project'])
})

test('chave parcial mostra somente os cinco últimos caracteres', () => {
  assert.equal(partialKey('ABCDE99999'), '••••• 99999')
  assert.equal(partialKey(null), null)
})

test('campos opcionais nulos não quebram o modelo visual', () => {
  const result = normalizeOffice({ installations: [installation({ edition: null, licenseDescription: null, partialProductKey: null })] })
  assert.equal(result.installations[0].edition, null)
  assert.equal(partialKey(result.installations[0].partialProductKey), null)
})

test('texto grande é aceito sem transformação destrutiva', () => {
  const description = 'x'.repeat(10000)
  assert.equal(normalizeOffice({ installations: [installation({ licenseDescription: description })] }).installations[0].licenseDescription.length, 10000)
})

test('fingerprint não participa do modelo consumido pela UI', () => {
  const result = normalizeOffice({ installations: [installation({ fingerprint: 'secret' })] })
  assert.equal(Object.hasOwn(result.installations[0], 'fingerprint'), false)
  assert.equal(Object.hasOwn(result.installations[0], 'warnings'), false)
  assert.equal(Object.hasOwn(result.installations[0], 'stdout'), false)
})
