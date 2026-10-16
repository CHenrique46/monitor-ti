import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { test } from 'node:test'
import { CHAT_IDLE_TIMEOUT_MS, CHAT_IDLE_WARNING_MS, createChatInactivityController } from '../src/components/chatInactivity.js'

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const component = await readFile(path.join(dashboardRoot, 'src/components/CertificateChat.jsx'), 'utf8')

function fakeClock() {
  let now = 0
  let nextId = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++nextId
      timers.set(id, { callback, at: now + delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    advance(milliseconds) {
      now += milliseconds
      let next = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0]
      while (next && next[1].at <= now) {
        timers.delete(next[0])
        next[1].callback()
        next = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0]
      }
    }
  }
}

test('avisa apos quatro minutos e encerra apos cinco minutos', () => {
  const clock = fakeClock()
  let warnings = 0
  let resets = 0
  const controller = createChatInactivityController({ now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout, onWarning: () => { warnings += 1 }, onTimeout: () => { resets += 1 } })
  controller.start()
  clock.advance(CHAT_IDLE_WARNING_MS - 1)
  assert.equal(warnings, 0)
  clock.advance(1)
  assert.equal(warnings, 1)
  clock.advance(CHAT_IDLE_TIMEOUT_MS - CHAT_IDLE_WARNING_MS)
  assert.equal(resets, 1)
  controller.dispose()
})

test('atividade renova o prazo e operacao ocupada impede encerramento', () => {
  const clock = fakeClock()
  let warnings = 0
  let resets = 0
  let busy = false
  const controller = createChatInactivityController({ now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout, isBusy: () => busy, onWarning: () => { warnings += 1 }, onTimeout: () => { resets += 1 } })
  controller.start()
  clock.advance(CHAT_IDLE_WARNING_MS)
  assert.equal(warnings, 1)
  controller.activity()
  clock.advance(CHAT_IDLE_WARNING_MS - 1)
  assert.equal(warnings, 1)
  busy = true
  clock.advance(1)
  assert.equal(warnings, 2)
  clock.advance(CHAT_IDLE_TIMEOUT_MS - CHAT_IDLE_WARNING_MS)
  assert.equal(resets, 0)
  busy = false
  controller.activity()
  clock.advance(CHAT_IDLE_TIMEOUT_MS)
  assert.equal(resets, 1)
  controller.dispose()
})

test('limpa timers ao desmontar e ignora respostas de turnos antigos', () => {
  const clock = fakeClock()
  let resets = 0
  const controller = createChatInactivityController({ now: clock.now, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout, onTimeout: () => { resets += 1 } })
  controller.start()
  controller.dispose()
  clock.advance(CHAT_IDLE_TIMEOUT_MS)
  assert.equal(resets, 0)
  assert.match(component, /if \(turnId !== turnRef\.current\) return/)
  assert.match(component, /confirmCertificate\(selected, false, turnId\)/)
  assert.match(component, /sessionIdRef\.current = `luca-\$\{Date\.now\(\)/)
})
