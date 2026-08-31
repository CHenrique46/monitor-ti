import { NavLink, Link } from 'react-router-dom'

export default function SiteNav() {
  return (
    <header className="site-header">
      <Link className="site-brand" to="/">
        Monitor TI
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
