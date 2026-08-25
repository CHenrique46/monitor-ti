import { useState, useEffect } from 'react'

const API = 'http://127.0.0.1:4000'

function sistemaLabel(s) {
  if (s === 'win32' || s === 'Windows_NT') return 'Windows'
  if (s === 'darwin') return 'macOS'
  if (s === 'linux') return 'Linux'
  return s || '-'
}

function App() {
  const [serverOk, setServerOk] = useState(false)
  const [computadores, setComputadores] = useState([])

  useEffect(() => {
    const load = async () => {
      try {
        const h = await fetch(`${API}/health`)
        setServerOk(h.ok)
      } catch (e) {
        setServerOk(false)
      }

      try {
        const r = await fetch(`${API}/api/computadores`)
        if (r.ok) {
          setComputadores(await r.json())
        }
      } catch (e) {
        // mantem lista anterior em caso de falha transitória
      }
    }

    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="container">
      <h1>Monitor TI</h1>
      <p>
        Servidor:{' '}
        <span className={serverOk ? 'online' : 'offline'}>
          {serverOk ? 'Online' : 'Offline'}
        </span>
      </p>

      <h2>Computadores</h2>
      <hr />

      {computadores.length === 0 && (
        <p className="muted">Nenhum computador conectado.</p>
      )}

      {computadores.map((c) => (
        <div className="card" key={c.id}>
          <div className="hostname">{c.hostname || '(sem nome)'}</div>
          <div>Usuário: {c.usuario || '-'}</div>
          <div>IP: {c.ip || '-'}</div>
          <div>Sistema: {sistemaLabel(c.sistema)}</div>
          <div>
            Status:{' '}
            <span className={c.status === 'online' ? 'online' : 'offline'}>
              {c.status === 'online' ? 'Online' : 'Offline'}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

export default App
