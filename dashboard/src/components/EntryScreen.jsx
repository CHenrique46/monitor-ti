export default function EntryScreen({ authenticated = false, onAdminPanel, onAdminLogin }) {
  return <main className="entry-shell">
    <section className="entry-card" aria-labelledby="entry-title">
      <div className="entry-brand"><span className="brand-mark" aria-hidden="true">HT</span><div><strong>HenriTech</strong><small>Controle de TI</small></div></div>
      <p className="eyebrow">Acesso seguro</p>
      <h1 id="entry-title">Como você deseja entrar?</h1>
      <p className="entry-subtitle">Escolha o ambiente que deseja acessar.</p>
      <div className="entry-options">
        <button type="button" className="entry-option entry-option-primary" onClick={authenticated ? onAdminPanel : onAdminLogin}>
          <strong>Painel administrativo</strong>
          <span>{authenticated ? 'Acessar o monitoramento e gerenciamento de TI' : 'Entrar com credenciais de operador'}</span>
        </button>
        <a className="entry-option" href="/portal/certificados">
          <strong>Solicitar certificado</strong>
          <span>Identificar esta estação e solicitar um certificado</span>
        </a>
      </div>
    </section>
  </main>
}
