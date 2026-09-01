export const UPTIME_DAY_SECONDS = 24 * 60 * 60

export const UPTIME_THRESHOLDS = Object.freeze({
  attention: 5 * UPTIME_DAY_SECONDS,
  rebootRecommended: 7 * UPTIME_DAY_SECONDS
})

export const UPTIME_STATUS = Object.freeze({
  NORMAL: 'NORMAL',
  ATTENTION: 'ATTENTION',
  REBOOT_RECOMMENDED: 'REBOOT_RECOMMENDED',
  UNKNOWN: 'UNKNOWN'
})

export function getUptimeStatus(uptimeSeconds) {
  if (uptimeSeconds === null || uptimeSeconds === undefined || uptimeSeconds === '') return UPTIME_STATUS.UNKNOWN
  const uptime = Number(uptimeSeconds)
  if (!Number.isFinite(uptime) || uptime < 0) return UPTIME_STATUS.UNKNOWN
  if (uptime >= UPTIME_THRESHOLDS.rebootRecommended) return UPTIME_STATUS.REBOOT_RECOMMENDED
  if (uptime >= UPTIME_THRESHOLDS.attention) return UPTIME_STATUS.ATTENTION
  return UPTIME_STATUS.NORMAL
}

export function uptimeStatusLabel(status) {
  switch (status) {
    case UPTIME_STATUS.ATTENTION:
      return 'Atenção'
    case UPTIME_STATUS.REBOOT_RECOMMENDED:
      return 'Reinício recomendado'
    case UPTIME_STATUS.NORMAL:
      return 'Normal'
    default:
      return 'Não informado'
  }
}
