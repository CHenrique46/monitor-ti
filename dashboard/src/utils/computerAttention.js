import { getUptimeStatus, UPTIME_STATUS } from './uptime.js'

function alertsForComputer(computer, activeAlerts = []) {
  return activeAlerts.filter((alert) => alert.computadorId === computer.id)
}

export function computerRequiresAttention(computer, activeAlerts = []) {
  const hasActiveAlert = alertsForComputer(computer, activeAlerts).length > 0
  const uptimeStatus = getUptimeStatus(computer.uptime)
  return hasActiveAlert || [UPTIME_STATUS.ATTENTION, UPTIME_STATUS.REBOOT_RECOMMENDED].includes(uptimeStatus)
}

export function getComputerPriority(computer, activeAlerts = []) {
  const alerts = alertsForComputer(computer, activeAlerts)
  const hasCriticalAlert = alerts.some((alert) => alert.nivel === 'critical')
  const hasAlert = alerts.length > 0
  const uptimeStatus = getUptimeStatus(computer.uptime)

  if (hasCriticalAlert) return 0
  if (hasAlert) return 1
  if (uptimeStatus === UPTIME_STATUS.REBOOT_RECOMMENDED) return 2
  if (uptimeStatus === UPTIME_STATUS.ATTENTION) return 3
  if (uptimeStatus === UPTIME_STATUS.NORMAL) return 4
  return 5
}

export function sortComputadoresByPriority(computers, activeAlerts = []) {
  return [...computers].sort((a, b) => {
    const priorityDiff = getComputerPriority(a, activeAlerts) - getComputerPriority(b, activeAlerts)
    if (priorityDiff !== 0) return priorityDiff
    return (a.hostname || '').localeCompare(b.hostname || '')
  })
}
