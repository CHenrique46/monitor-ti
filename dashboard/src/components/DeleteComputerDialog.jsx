import { useEffect, useState } from 'react'
import { fmtDate } from '../utils/formatters'

export default function DeleteComputerDialog({ computer, onCancel, onConfirm, error, submitting }) {
  const [confirmation, setConfirmation] = useState('')
  const canConfirm = confirmation === 'EXCLUIR' && !submitting

  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === 'Escape' && !submitting) onCancel() }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onCancel, submitting])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onCancel() }}>
      <section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-computer-title" aria-describedby="delete-computer-description">
        <span className="section-kicker">Ação permanente</span>
        <h2 id="delete-computer-title">Excluir computador?</h2>
        <div className="delete-computer-meta">
          <strong>Hostname: {computer.hostname || '(sem nome)'}</strong>
          <span>IP: {computer.ip || 'não informado'}</span>
          <span>Agent: v{computer.agentVersion || 'desconhecida'}</span>
          <span>Última comunicação: {fmtDate(computer.ultimaConexao)}</span>
        </div>
        <p id="delete-computer-description">Esta ação removerá o computador e seu histórico de monitoramento do HenriTech Control. Esta ação não pode ser desfeita.</p>
        <p className="muted">Isso não desinstala nem altera o Agent instalado na máquina.</p>
        <label className="delete-confirm-field">
          Digite <strong>EXCLUIR</strong> para confirmar
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoFocus disabled={submitting} />
        </label>
        {error && <div className="update-status failed" role="alert">{error}</div>}
        <div className="confirm-actions">
          <button type="button" className="btn-cancel" onClick={onCancel} disabled={submitting}>Cancelar</button>
          <button type="button" className="btn-danger" onClick={onConfirm} disabled={!canConfirm}>{submitting ? 'Excluindo...' : 'Excluir definitivamente'}</button>
        </div>
      </section>
    </div>
  )
}
