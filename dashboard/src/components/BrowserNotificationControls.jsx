import { useEffect, useState } from 'react'
import { API_URL } from '../config'
import './BrowserNotificationControls.css'
import { createBrowserNotificationDispatcher } from './browserNotificationContract'

export default function BrowserNotificationControls({ basePath, label }) {
  const [enabled, setEnabled] = useState(false)
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    fetch(`${API_URL}${basePath}/status`, { credentials: 'include' })
      .then((response) => response.ok ? response.json() : { enabled: false })
      .then((body) => { if (active) setEnabled(body.enabled === true) })
      .catch(() => {})
    return () => { active = false }
  }, [basePath])

  useEffect(() => {
    if (!enabled || permission !== 'granted' || !window.isSecureContext || typeof EventSource === 'undefined') return undefined
    const source = new EventSource(`${API_URL}${basePath}/events`, { withCredentials: true })
    const notify = createBrowserNotificationDispatcher()
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        const notification = notify(payload)
        if (!notification) return
        notification.onclick = () => { window.focus(); notification.close() }
      } catch {}
    }
    source.onerror = () => setMessage('Canal aguardando reconexão.')
    return () => source.close()
  }, [basePath, enabled, permission])

  async function enableNotifications() {
    if (typeof Notification === 'undefined' || !window.isSecureContext) return setMessage('Este navegador exige um contexto seguro para notificações.')
    const next = await Notification.requestPermission()
    setPermission(next)
    setMessage(next === 'granted' ? 'Notificações ativadas nesta aba.' : 'Permissão de notificações não concedida.')
  }

  if (!enabled) return null
  return <div className="browser-notification-controls" aria-live="polite">
    <span>{label}</span>
    {permission !== 'granted' && permission !== 'unsupported' && <button type="button" onClick={enableNotifications}>Ativar notificações</button>}
    {permission === 'unsupported' && <span className="browser-notification-muted">API Notification indisponível.</span>}
    {message && <span className="browser-notification-muted">{message}</span>}
  </div>
}
