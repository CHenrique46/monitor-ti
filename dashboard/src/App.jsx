import { useState, useEffect } from 'react'

const API_URL = 'http://127.0.0.1:4000/health'

function App() {
  const [status, setStatus] = useState('verificando...')

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(API_URL)
        if (res.ok) {
          const data = await res.json()
          setStatus(data.status === 'ok' ? 'Online' : 'Offline')
        } else {
          setStatus('Offline')
        }
      } catch (e) {
        setStatus('Offline')
      }
    }

    check()
    const interval = setInterval(check, 5000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="container">
      <h1>Monitor TI</h1>
      <p>
        Servidor:{' '}
        <span className={status === 'Online' ? 'online' : status === 'verificando...' ? 'checking' : 'offline'}>
          {status}
        </span>
      </p>
    </div>
  )
}

export default App
