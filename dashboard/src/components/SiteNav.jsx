import { NavLink, Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

const navigationItems = [
  { key: 'overview', to: '/', label: 'Visão Geral', end: true },
  { key: 'alerts', to: '/avisos', label: 'Avisos' },
  { key: 'maintenance', to: '/manutencao-programada', label: 'Manutenção Programada' }
]

export default function SiteNav() {
  const location = useLocation()
  const { user, logout } = useAuth()

  return (
    <header className="site-header">
      <Link className="site-brand" to="/" aria-label="HenriTech Control">
        <span className="brand-mark" aria-hidden="true">HT</span>
        <span className="brand-copy">
          <strong className="brand-name"><span className="brand-full-name">HenriTech Control</span><span className="brand-short-name">HT Control</span></strong>
          <small>Painel de Monitoramento e Gerenciamento de TI</small>
        </span>
      </Link>
      <nav className="site-nav" aria-label="Navegação principal">
        {navigationItems.map((item) => (
          <NavLink
            key={item.key}
            to={item.to}
            end={item.end}
            className={({ isActive }) => {
              const overviewActive = item.key === 'overview' && location.pathname.startsWith('/computadores/')
              return isActive || overviewActive ? 'site-nav-link active' : 'site-nav-link'
            }}
            aria-current={
              item.key === 'overview' && (location.pathname === '/' || location.pathname.startsWith('/computadores/'))
                ? 'page'
                : undefined
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="site-account"><span>{user.username}</span><button type="button" onClick={logout}>Sair</button></div>
    </header>
  )
}
