export async function apiFetch(input, options = {}) {
  const response = await fetch(input, { ...options, credentials: 'include' })
  if (response.status === 401) window.dispatchEvent(new Event('auth-expired'))
  return response
}
