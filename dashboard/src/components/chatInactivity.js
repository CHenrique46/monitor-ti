export const CHAT_IDLE_WARNING_MS = 4 * 60 * 1000
export const CHAT_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export function createChatInactivityController({
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  isBusy = () => false,
  onWarning,
  onTimeout
} = {}) {
  let lastActivityAt = now()
  let warningShown = false
  let timer = null
  let disposed = false

  function schedule() {
    if (disposed) return
    if (timer !== null) clearTimeoutImpl(timer)
    const elapsed = now() - lastActivityAt
    const target = warningShown ? CHAT_IDLE_TIMEOUT_MS : CHAT_IDLE_WARNING_MS
    timer = setTimeoutImpl(check, Math.max(100, target - elapsed))
  }

  function check() {
    timer = null
    if (disposed) return
    const elapsed = now() - lastActivityAt
    if (elapsed >= CHAT_IDLE_TIMEOUT_MS) {
      if (!isBusy()) {
        warningShown = false
        lastActivityAt = now()
        onTimeout?.()
      }
      schedule()
      return
    }
    if (elapsed >= CHAT_IDLE_WARNING_MS && !warningShown) {
      warningShown = true
      onWarning?.()
    }
    schedule()
  }

  return {
    start() { schedule() },
    activity() {
      lastActivityAt = now()
      warningShown = false
      schedule()
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimeoutImpl(timer)
      timer = null
    }
  }
}
