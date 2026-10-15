import { API_URL } from '../config'

async function readResponse(response, fallback) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.erro || fallback), { status: response.status })
  return body
}

export async function searchCertificateCatalog(query, signal) {
  const params = new URLSearchParams({ page: '1', pageSize: '5', q: query.trim() })
  return readResponse(
    await fetch(`${API_URL}/api/portal/certificados?${params.toString()}`, { credentials: 'include', signal }),
    'Não foi possível consultar o catálogo.'
  )
}

export async function createCertificateRequest({ certificadoId, motivo = '' }) {
  return readResponse(
    await fetch(`${API_URL}/api/portal/solicitacoes`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certificadoId, motivo })
    }),
    'Não foi possível enviar a solicitação.'
  )
}

export async function listCertificateRequests() {
  return readResponse(
    await fetch(`${API_URL}/api/portal/solicitacoes?page=1&pageSize=100`, { credentials: 'include' }),
    'Não foi possível verificar suas solicitações.'
  )
}
