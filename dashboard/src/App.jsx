import { useEffect, useState } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import Dashboard from './components/Dashboard'
import ComputerDetails from './components/ComputerDetails'
import Avisos from './components/Avisos'
import MaintenanceSchedules from './components/MaintenanceSchedules'
import Inventory from './components/Inventory'
import Certificados from './components/Certificados'
import Login from './components/Login'
import { API_URL } from './config'
import { AuthContext } from './auth/AuthContext'
import PortalCertificados from './components/PortalCertificados'
import SolicitacoesCertificado from './components/SolicitacoesCertificado'
import { PendingRequestsProvider } from './components/PendingRequestsProvider'
import EntryScreen from './components/EntryScreen'

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [connectionError, setConnectionError] = useState(false)
  const [adminLoginRequested, setAdminLoginRequested] = useState(false)

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

  if (location.pathname.startsWith('/portal')) return <Routes><Route path="/portal/certificados" element={<PortalCertificados />} /></Routes>
  if (location.pathname === '/' && !adminLoginRequested) return <EntryScreen authenticated={Boolean(user)} onAdminPanel={() => navigate('/admin')} onAdminLogin={() => setAdminLoginRequested(true)} />
  if (loading) return <main className="login-shell"><p className="login-loading">Verificando sessão...</p></main>
  if (!user) return <Login connectionError={connectionError} onAuthenticated={(authenticatedUser) => { setConnectionError(false); setUser(authenticatedUser); setAdminLoginRequested(false); navigate('/') }} />

  return (
    <AuthContext.Provider value={{ user, logout, refreshSession: loadSession }}>
      <PendingRequestsProvider>
        <Routes>
          <Route path="/admin" element={<Dashboard />} />
          <Route path="/" element={<EntryScreen authenticated onAdminPanel={() => navigate('/admin')} onAdminLogin={() => navigate('/admin')} />} />
          <Route path="/avisos" element={<Avisos />} />
          <Route path="/manutencao-programada" element={<MaintenanceSchedules />} />
          <Route path="/inventario" element={<Inventory />} />
          <Route path="/certificados" element={<Certificados />} />
          <Route path="/certificados/solicitacoes" element={<SolicitacoesCertificado />} />
          <Route path="/computadores/:id" element={<ComputerDetails />} />
          <Route path="*" element={<main className="container"><p className="eyebrow">Página não encontrada</p><h1>Não encontramos esta tela</h1><p className="muted">A rota informada não existe no HenriTech Control.</p><a className="details-link" href="/">Voltar ao Dashboard</a></main>} />
        </Routes>
      </PendingRequestsProvider>
    </AuthContext.Provider>
  )
}
