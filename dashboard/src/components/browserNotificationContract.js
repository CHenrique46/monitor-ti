export const BROWSER_NOTIFICATION_MESSAGES = {
  CERTIFICATE_REQUEST_CREATED: { title: 'Nova solicitação de certificado', body: 'Uma estação enviou uma solicitação para análise.' },
  CERTIFICATE_RELEASED: { title: 'Certificado liberado', body: 'O certificado solicitado está disponível para esta estação.' }
}

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isBrowserNotificationEvent(payload) {
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 2 && EVENT_ID.test(payload.eventId || '') && BROWSER_NOTIFICATION_MESSAGES[payload.eventType])
}

export function createBrowserNotificationDispatcher(NotificationCtor = globalThis.Notification) {
  const seen = new Set()

  return (payload) => {
    if (!isBrowserNotificationEvent(payload) || seen.has(payload.eventId)) return null
    seen.add(payload.eventId)
    if (seen.size > 100) seen.delete(seen.values().next().value)

    const message = BROWSER_NOTIFICATION_MESSAGES[payload.eventType]
    try {
      return new NotificationCtor(message.title, {
        body: message.body,
        tag: `monitor-ti-${payload.eventId}`,
        renotify: true
      })
    } catch {
      return null
    }
  }
}
