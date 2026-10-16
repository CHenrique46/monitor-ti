import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const component = await readFile(path.join(dashboardRoot, 'src/components/PortalCertificados.jsx'), 'utf8')
const styles = await readFile(path.join(dashboardRoot, 'src/index.css'), 'utf8')

test('portal deixa o chat principal e abre pesquisa tradicional sob demanda', () => {
  assert.match(styles, /\.portal-content-grid\.is-search-open[^\n]*grid-template-columns/)
  assert.match(styles, /\.portal-content-grid\.is-search-closed[^\n]*display: block/)
  assert.match(component, /portal-workspace portal-content-grid/)
  assert.match(component, /portal-search-area/)
  assert.match(component, /traditionalSearchOpen/)
  assert.match(component, /Voltar ao chat/)
  assert.match(styles, /\.portal-content-grid\.is-search-open \.portal-chat-column[^\n]*display: none/)
})

test('portal ordena prioridades e limita historico somente na apresentacao', () => {
  assert.match(component, /function requestPriority\(request\)/)
  assert.match(component, /request\.statusLiberacao === 'LIBERADO' && request\.liberacao/)
  assert.match(component, /request\.estado === 'PENDENTE'/)
  assert.match(component, /request\.estado === 'NEGADA'/)
  assert.match(component, /request\.statusLiberacao === 'EXPIRADA'/)
  assert.match(component, /sortRequests\(requests\.items\)/)
  assert.match(component, /Ver solicitações anteriores/)
  assert.match(component, /showHistory/)
  assert.match(component, /Ver histórico completo/)
})

test('portal preserva mensagem publica sanitizada e nao oferece clipboard', () => {
  assert.match(component, /Certificado disponível na pasta Certificados\./)
  assert.match(component, /Disponível até:/)
  assert.equal(component.includes('navigator.clipboard'), false)
  assert.equal(component.includes('nomeArquivoLiberado'), false)
  assert.equal(component.includes('compartilhamento'), false)
  assert.equal(component.includes('\\\\192.168.40.250'), false)
})

test('chat oferece pesquisa sem depender da IA e preserva consulta', async () => {
  const chat = await readFile(path.join(dashboardRoot, 'src/components/CertificateChat.jsx'), 'utf8')
  assert.match(chat, /Oi! Eu sou o Luca 😊 Me diga qual certificado você procura\./)
  assert.match(chat, /Abrir pesquisa tradicional/)
  assert.match(chat, /pesquisa tradicional\|pesquisar certificado/)
  assert.match(chat, /CERTIFICATE_PORTAL_READ_ONLY/)
})
