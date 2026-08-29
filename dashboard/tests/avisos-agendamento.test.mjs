import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WEEKDAY_OPTIONS,
  buildAgendamentoCreatePayload,
  buildAgendamentoDraft,
  buildAgendamentoUpdateBody,
  describeScheduleTarget,
  formatApiError,
  formatRecurrenceLabel,
  formatScheduleStatus,
  formatZoneDateTime,
  getScheduleFormFromRecord,
  saoPauloToUtc
} from '../src/utils/avisos.js'

const now = saoPauloToUtc(2026, 8, 28, 10, 0)

test('once monta payload e resumo', () => {
  const draft = buildAgendamentoDraft({ tipo: 'once', data: '2026-08-29', hora: '17:00' }, now)
  assert.equal(draft.tipo, 'once')
  assert.equal(draft.data, '2026-08-29')
  assert.equal(draft.hora, '17:00')
  assert.ok(draft.scheduledAt instanceof Date)
  assert.match(draft.summary, /Uma vez/i)

  const { payload } = buildAgendamentoCreatePayload(
    {
      titulo: 'Aviso',
      mensagem: 'Teste',
      nivel: 'info',
      alvoTipo: 'todos',
      tipo: 'once',
      data: '2026-08-29',
      hora: '17:00'
    },
    [],
    now
  )
  assert.equal(payload.envio, 'agendar')
  assert.equal(payload.agendamento.tipo, 'once')
  assert.equal(payload.agendamento.data, '2026-08-29')
  assert.equal(payload.agendamento.hora, '17:00')
})

test('daily monta primeira execucao e resumo', () => {
  const draft = buildAgendamentoDraft({ tipo: 'daily', hora: '17:00' }, now)
  assert.equal(draft.tipo, 'daily')
  assert.equal(draft.hora, '17:00')
  assert.match(draft.summary, /Diariamente às 17:00/)
  assert.ok(draft.scheduledAt.getTime() > now.getTime())
})

test('weekly monta dia único e resumo', () => {
  const draft = buildAgendamentoDraft({ tipo: 'weekly', diaSemana: 0, hora: '17:00' }, now)
  assert.equal(draft.tipo, 'weekly')
  assert.equal(draft.diaSemana, 0)
  assert.match(draft.summary, /Toda domingo às 17:00/)
  assert.ok(draft.scheduledAt.getTime() > now.getTime())
})

test('data passada é rejeitada', () => {
  assert.throws(
    () => buildAgendamentoDraft({ tipo: 'once', data: '2026-08-28', hora: '09:00' }, now),
    /futura/i
  )
})

test('mapeia dias da semana', () => {
  assert.deepEqual(
    WEEKDAY_OPTIONS.map((item) => item.short),
    ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
  )
})

test('edicao monta body de update', () => {
  const body = buildAgendamentoUpdateBody(
    {
      titulo: 'Aviso',
      mensagem: 'Teste',
      nivel: 'aviso',
      alvoTipo: 'selecionados',
      tipo: 'weekly',
      diaSemana: 4,
      hora: '17:00'
    },
    [1, 2],
    now
  )
  assert.equal(body.tipo, 'weekly')
  assert.equal(body.diaSemana, 4)
  assert.deepEqual(body.alvoIds, [1, 2])
  assert.equal(body.hora, '17:00')
})

test('exclusao e status mantem leitura simples', () => {
  assert.equal(formatScheduleStatus({ ativo: true }), 'Ativo')
  assert.equal(formatScheduleStatus({ ativo: false }), 'Inativo')
})

test('apresenta proxima execucao e trata erro da api', () => {
  const when = saoPauloToUtc(2026, 8, 29, 17, 0)
  assert.match(formatZoneDateTime(when), /29\/08\/2026/)
  assert.match(formatRecurrenceLabel({ tipo: 'daily', proximaExecucao: when }), /Diariamente às 17:00/)
  assert.equal(describeScheduleTarget({ alvoTipo: 'online' }), 'Máquinas online')
  assert.equal(formatApiError({ erro: 'Falha' }), 'Falha')
})
