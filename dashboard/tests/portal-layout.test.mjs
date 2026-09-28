import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const component = await readFile(path.join(dashboardRoot, 'src/components/PortalCertificados.jsx'), 'utf8')
const styles = await readFile(path.join(dashboardRoot, 'src/index.css'), 'utf8')

test('portal organiza pesquisa e solicitacoes em duas areas responsivas', () => {
  assert.match(styles, /\.portal-workspace[^\n]*grid-template-columns: minmax\(0, 3fr\) minmax\(300px, 2fr\)/)
  assert.match(styles, /\.portal-requests[^\n]*order: -1/)
  assert.match(component, /className="portal-workspace"/)
  assert.match(component, /className="portal-search-area"/)
  assert.match(component, /className="portal-requests"/)
})

test('portal ordena prioridades e limita historico somente na apresentacao', () => {
  assert.match(component, /function requestPriority\(request\)/)
  assert.match(component, /request\.statusLiberacao === 'LIBERADO' && request\.liberacao/)
  assert.match(component, /request\.estado === 'PENDENTE'/)
  assert.match(component, /request\.estado === 'NEGADA'/)
  assert.match(component, /request\.statusLiberacao === 'EXPIRADA'/)
  assert.match(component, /sortRequests\(requests\.items\)/)
  assert.match(component, /Ver solicitações anteriores/)
})

test('portal preserva mensagem publica sanitizada e nao oferece clipboard', () => {
  assert.match(component, /Certificado disponível na pasta Certificados\./)
  assert.match(component, /Disponível até:/)
  assert.equal(component.includes('navigator.clipboard'), false)
  assert.equal(component.includes('nomeArquivoLiberado'), false)
  assert.equal(component.includes('compartilhamento'), false)
  assert.equal(component.includes('\\\\192.168.40.250'), false)
})
