import { useEffect, useState } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import Dashboard from './components/Dashboard'
import ComputerDetails from './components/ComputerDetails'
import Avisos from './components/Avisos'
import MaintenanceSchedules from './components/MaintenanceSchedules'
import Inventory from './components/Inventory'
import Certificados from './components/Certificados'
import Login from './components/Login'
import { API_URL } from './config'
import { AuthContext } from './auth/AuthContext'

export default function App() {
  const navigate = useNavigate()
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [connectionError, setConnectionError] = useState(false)

  const loadSession = async () => {
    try {
      const response = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' })
      if (response.ok) {
        setUser(await response.json())
        setConnectionError(false)
      } else {
        setUser(null)
      }
    } catch {
      setUser(null)
      setConnectionError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSession()
    const timer = setInterval(loadSession, 60000)
    const expire = () => { setUser(null); navigate('/') }
    window.addEventListener('auth-expired', expire)
    return () => { clearInterval(timer); window.removeEventListener('auth-expired', expire) }
  }, [])

  const logout = async () => {
    try { await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' }) } finally {
      setUser(null)
      navigate('/')
    }
  }

  if (loading) return <main className="login-shell"><p className="login-loading">Verificando sessão...</p></main>
  if (!user) return <Login connectionError={connectionError} onAuthenticated={(authenticatedUser) => { setConnectionError(false); setUser(authenticatedUser); navigate('/') }} />

  return (
    <AuthContext.Provider value={{ user, logout, refreshSession: loadSession }}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/avisos" element={<Avisos />} />
        <Route path="/manutencao-programada" element={<MaintenanceSchedules />} />
        <Route path="/inventario" element={<Inventory />} />
        <Route path="/certificados" element={<Certificados />} />
        <Route path="/computadores/:id" element={<ComputerDetails />} />
      </Routes>
    </AuthContext.Provider>
  )
}
