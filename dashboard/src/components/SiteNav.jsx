import { NavLink, Link } from 'react-router-dom'

export default function SiteNav() {
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
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'site-nav-link active' : 'site-nav-link')}>
          Computadores
        </NavLink>
        <NavLink to="/avisos" className={({ isActive }) => (isActive ? 'site-nav-link active' : 'site-nav-link')}>
          Avisos
        </NavLink>
        <NavLink to="/manutencao-programada" className={({ isActive }) => (isActive ? 'site-nav-link active' : 'site-nav-link')}>
          Manutenção programada
        </NavLink>
      </nav>
    </header>
  )
}
