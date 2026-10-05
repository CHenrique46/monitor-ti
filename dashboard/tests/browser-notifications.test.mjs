import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { BROWSER_NOTIFICATION_MESSAGES, createBrowserNotificationDispatcher, isBrowserNotificationEvent } from '../src/components/browserNotificationContract.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const component = await readFile(path.join(root, 'src/components/BrowserNotificationControls.jsx'), 'utf8')
const contract = await readFile(path.join(root, 'src/components/browserNotificationContract.js'), 'utf8')

test('contrato frontend aceita somente evento allowlisted com UUID e sem campos extras', () => {
  const valid = { eventId: '123e4567-e89b-12d3-a456-426614174000', eventType: 'CERTIFICATE_RELEASED' }
  assert.equal(isBrowserNotificationEvent(valid), true)
  assert.equal(isBrowserNotificationEvent({ ...valid, extra: 'nope' }), false)
  assert.equal(isBrowserNotificationEvent({ ...valid, eventId: 'invalid' }), false)
  assert.equal(isBrowserNotificationEvent({ ...valid, eventType: 'UNKNOWN' }), false)
  assert.deepEqual(Object.keys(BROWSER_NOTIFICATION_MESSAGES).sort(), ['CERTIFICATE_RELEASED', 'CERTIFICATE_REQUEST_CREATED'])
})

test('frontend cobre permissão, segurança, reconexão, deduplicação e cleanup', () => {
  assert.match(component, /typeof Notification === 'undefined'/)
  assert.match(component, /window\.isSecureContext/)
  assert.match(component, /Notification\.permission/)
  assert.match(component, /Notification\.requestPermission\(\)/)
  assert.match(component, /permission !== 'granted'/)
  assert.match(component, /new EventSource\(/)
  assert.match(component, /source\.onerror/)
  assert.match(component, /source\.close\(\)/)
  assert.match(component, /createBrowserNotificationDispatcher\(\)/)
  assert.doesNotMatch(component, /Enviar notificação de teste/)
  assert.doesNotMatch(component, /sendTest/)
  assert.doesNotMatch(component, /tag:\s*payload\.eventType/)
  assert.match(component, /!enabled/)
  assert.match(contract, /isBrowserNotificationEvent\(payload\)/)
})

function mockNotification(created, shouldThrow = false) {
  return class MockNotification {
    constructor(title, options) {
      if (shouldThrow) throw new Error('constructor failure')
      this.title = title
      this.options = options
      created.push(this)
    }
  }
}

const eventA = { eventId: '123e4567-e89b-12d3-a456-426614174000', eventType: 'CERTIFICATE_RELEASED' }
const eventB = { eventId: '123e4567-e89b-12d3-a456-426614174001', eventType: 'CERTIFICATE_RELEASED' }
const eventOtherType = { eventId: '123e4567-e89b-12d3-a456-426614174002', eventType: 'CERTIFICATE_REQUEST_CREATED' }

test('eventId A cria uma notificação e eventId B do mesmo tipo cria outra sem fechar A', () => {
  const created = []
  const notify = createBrowserNotificationDispatcher(mockNotification(created))
  const first = notify(eventA)
  const second = notify(eventB)

  assert.equal(created.length, 2)
  assert.equal(first.options.tag, 'monitor-ti-' + eventA.eventId)
  assert.equal(second.options.tag, 'monitor-ti-' + eventB.eventId)
  assert.notEqual(first.options.tag, second.options.tag)
  assert.equal(second.options.renotify, true)
})

test('eventId repetido é ignorado e eventType diferente cria uma nova notificação', () => {
  const created = []
  const notify = createBrowserNotificationDispatcher(mockNotification(created))

  notify(eventA)
  assert.equal(notify(eventA), null)
  notify(eventOtherType)

  assert.equal(created.length, 2)
  assert.notEqual(created[0].options.tag, created[1].options.tag)
})

test('construtor que falha não propaga erro e IDs continuam limitados a 100', () => {
  const failed = createBrowserNotificationDispatcher(mockNotification([], true))
  assert.doesNotThrow(() => failed(eventA))

  const created = []
  const notify = createBrowserNotificationDispatcher(mockNotification(created))
  for (let index = 0; index < 101; index += 1) {
    notify({ eventId: `123e4567-e89b-12d3-a456-42661417${String(index).padStart(4, '0')}`, eventType: 'CERTIFICATE_RELEASED' })
  }
  assert.equal(created.length, 101)
  assert.equal(notify(eventA) !== null, true)
})
