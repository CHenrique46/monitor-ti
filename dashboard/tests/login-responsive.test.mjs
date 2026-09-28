import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const styles = await readFile(path.join(dashboardRoot, 'src/index.css'), 'utf8')
const login = await readFile(path.join(dashboardRoot, 'src/components/Login.jsx'), 'utf8')

test('login mobile mantém a cadeia de layout limitada ao viewport', () => {
  assert.match(styles, /html, body, #root\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%;/s)
  assert.match(styles, /\.login-shell\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%;/s)
  assert.match(styles, /\.login-card\s*\{[^}]*max-width:\s*440px;[^}]*min-width:\s*0;[^}]*width:\s*100%;/s)
})

test('controles do login não podem exceder o card', () => {
  assert.match(styles, /\.login-card form, \.login-card input, \.login-submit\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*width:\s*100%;/s)
  assert.doesNotMatch(styles, /\.login-card[^}]*overflow-x\s*:\s*hidden/s)
  assert.doesNotMatch(styles, /\.login-card[^}]*width:\s*calc\(100vw/s)
  assert.match(login, /className="login-card"/)
  assert.match(login, /id="login-username"/)
  assert.match(login, /id="login-password"/)
})
