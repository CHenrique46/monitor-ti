import test from 'node:test'
import assert from 'node:assert/strict'
import { isVersionNewer } from '../src/utils/version.js'

test('não indica downgrade para Agent 1.1.18', () => {
  assert.equal(isVersionNewer('1.1.10', '1.1.18'), false)
})

test('não indica downgrade para Agent 1.1.14-dev', () => {
  assert.equal(isVersionNewer('1.1.10', '1.1.14-dev'), false)
})

test('não indica downgrade para Agent 1.1.18-dev', () => {
  assert.equal(isVersionNewer('1.1.10', '1.1.18-dev'), false)
})

test('indica atualização de 1.1.9 para 1.1.10', () => {
  assert.equal(isVersionNewer('1.1.10', '1.1.9'), true)
})

test('não indica atualização para a mesma versão', () => {
  assert.equal(isVersionNewer('1.1.10', '1.1.10'), false)
})

test('indica atualização de 1.1.8 para 1.1.10', () => {
  assert.equal(isVersionNewer('1.1.10', '1.1.8'), true)
})
