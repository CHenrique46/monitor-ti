import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCertificateValidity } from '../src/formatCertificateValidity.js'

test('dashboard apresenta validade confirmada e estimada sem dados internos', () => {
  assert.deepEqual(formatCertificateValidity({ validadeFim: '2027-09-17T12:00:00.000Z', statusValidade: 'VALIDO_CONFIRMADO' }), {
    label: 'Validade: 17/09/2027', tone: 'confirmed', detail: null
  })
  assert.deepEqual(formatCertificateValidity({ validadeFim: '2027-09-17T12:00:00.000Z', statusValidade: 'VALIDADE_ESTIMADA' }), {
    label: 'Possível validade: 17/09/2027', tone: 'estimated', detail: 'Estimativa baseada na data do arquivo'
  })
  assert.deepEqual(formatCertificateValidity({ validadeFim: '2026-09-17T12:00:00.000Z', statusValidade: 'POSSIVELMENTE_VENCIDO' }), {
    label: 'Possivelmente vencido em 17/09/2026', tone: 'estimated-expired', detail: 'Data estimada'
  })
  assert.equal(formatCertificateValidity({ validadeFim: '2027-09-17T12:00:00.000Z', statusValidade: 'AMBIGUA' }).label, 'Validade precisa de conferência')
})
