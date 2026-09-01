import { computerRequiresAttention } from './computerAttention.js'
import { getUptimeStatus, UPTIME_STATUS } from './uptime.js'

export function buildOperationalSummary(computers = [], activeAlerts = []) {
  const computerIds = new Set(computers.map((computer) => computer.id))
  const criticalComputerIds = new Set(
    activeAlerts
      .filter((alert) => alert.nivel === 'critical')
      .filter((alert) => computerIds.has(alert.computadorId))
      .map((alert) => alert.computadorId)
  )

  return {
    total: computers.length,
    online: computers.filter((computer) => computer.status === 'online').length,
    offline: computers.filter((computer) => computer.status === 'offline').length,
    attention: computers.filter((computer) => computerRequiresAttention(computer, activeAlerts)).length,
    rebootRecommended: computers.filter((computer) => getUptimeStatus(computer.uptime) === UPTIME_STATUS.REBOOT_RECOMMENDED).length,
    criticalAlerts: criticalComputerIds.size
  }
}
