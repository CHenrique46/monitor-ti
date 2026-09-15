import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { API_URL } from '../config'
import { apiFetch } from '../api'
import { requestMarker, markerKey, PENDING_REQUESTS_STORAGE_KEY, shouldNotify } from '../pendingRequests'
import { AuthContext } from '../auth/AuthContext'
import './PendingRequestsProvider.css'

const PendingRequestsContext = createContext(null)
const NORMAL_TITLE = 'HenriTech Control'

function readStoredMarker() {
  try {
    const value = JSON.parse(window.localStorage.getItem(PENDING_REQUESTS_STORAGE_KEY) || 'null')
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function storeMarker(marker) {
  if (!marker) return
  try { window.localStorage.setItem(PENDING_REQUESTS_STORAGE_KEY, JSON.stringify(marker)) } catch {}
}

export function PendingRequestsProvider({ children }) {
  const { user } = useContext(AuthContext)
  const isAdmin = user?.role === 'ADMIN'
  const [summary, setSummary] = useState({ pendentes: 0, ultimaSolicitacaoId: null, ultimaSolicitacaoEm: null })
  const [notification, setNotification] = useState(null)
  const previousRef = useRef(null)
  const storedRef = useRef(null)
  const controllerRef = useRef(null)
  const sequenceRef = useRef(0)

  const refreshPendingRequests = useCallback(async () => {
    if (!isAdmin) return null
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const sequence = ++sequenceRef.current
    try {
      const response = await apiFetch(`${API_URL}/api/certificados/solicitacoes/resumo`, { signal: controller.signal })
      if (!response.ok || sequence !== sequenceRef.current) return null
      const next = await response.json()
      if (sequence !== sequenceRef.current) return null
      const previous = previousRef.current
      const previousMarker = previous ? requestMarker(previous) : null
      const nextMarker = requestMarker(next)
      if (previous && shouldNotify(previous.pendentes, next, previousMarker, storedRef.current)) {
        setNotification({ marker: nextMarker })
        storeMarker(nextMarker)
        storedRef.current = nextMarker
      } else if (next.pendentes === 0) {
        setNotification(null)
      }
      previousRef.current = next
      setSummary(next)
      return next
    } catch (error) {
      if (error.name !== 'AbortError') return null
      return null
    }
  }, [isAdmin])

  useEffect(() => {
    if (!isAdmin) {
      previousRef.current = null
      setSummary({ pendentes: 0, ultimaSolicitacaoId: null, ultimaSolicitacaoEm: null })
      setNotification(null)
      return undefined
    }
    storedRef.current = readStoredMarker()
    refreshPendingRequests()
    const poll = () => { if (document.visibilityState !== 'hidden') refreshPendingRequests() }
    const onVisibilityChange = () => { if (document.visibilityState !== 'hidden') refreshPendingRequests() }
    const timer = window.setInterval(poll, 30000)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      controllerRef.current?.abort()
      sequenceRef.current += 1
    }
  }, [isAdmin, refreshPendingRequests])

  useEffect(() => {
    document.title = isAdmin && summary.pendentes > 0 ? `(${summary.pendentes}) ${NORMAL_TITLE}` : NORMAL_TITLE
    return () => { document.title = NORMAL_TITLE }
  }, [isAdmin, summary.pendentes])

  const value = { pendingCount: isAdmin ? summary.pendentes : 0, refreshPendingRequests }
  return (
    <PendingRequestsContext.Provider value={value}>
      {children}
      {isAdmin && notification && (
        <div className="pending-request-notification" role="status" aria-live="polite">
          <Link to="/certificados/solicitacoes" onClick={() => setNotification(null)}>
            Nova solicitação de certificado recebida
          </Link>
        </div>
      )}
    </PendingRequestsContext.Provider>
  )
}

export function usePendingRequests() {
  const value = useContext(PendingRequestsContext)
  if (!value) throw new Error('usePendingRequests deve ser usado dentro de PendingRequestsProvider')
  return value
}

export { markerKey }
