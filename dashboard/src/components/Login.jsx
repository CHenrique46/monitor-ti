import { useState } from 'react'
import { API_URL } from '../config'

export default function Login({ onAuthenticated, connectionError = false }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
      if (!response.ok) {
        setError(response.status === 429 ? 'Muitas tentativas. Tente novamente mais tarde.' : 'Usuário ou senha inválidos.')
        return
      }
      setPassword('')
      onAuthenticated(await response.json())
    } catch {
      setError('Não foi possível conectar ao servidor.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand"><span className="brand-mark" aria-hidden="true">HT</span><div><strong>HenriTech Control</strong><small>HT Control</small></div></div>
        <h1 id="login-title">Acesso ao painel</h1>
        <p className="login-subtitle">Entre com suas credenciais de operador.</p>
        {(error || connectionError) && <div className="login-error" role="alert">{error || 'Não foi possível verificar a sessão. Tente novamente.'}</div>}
        <form onSubmit={submit}>
          <label htmlFor="login-username">Usuário</label>
          <input id="login-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          <label htmlFor="login-password">Senha</label>
          <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <button className="login-submit" type="submit" disabled={busy}>{busy ? 'Entrando...' : 'Entrar'}</button>
        </form>
      </section>
    </main>
  )
}
