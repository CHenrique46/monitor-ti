const ACTIVATION_STATUS = {
  LICENSED: { label: 'Licenciado', tone: 'ok' },
  UNLICENSED: { label: 'Não licenciado', tone: 'failed' },
  NOTIFICATION: { label: 'Requer atenção', tone: 'attention' },
  GRACE: { label: 'Período de carência', tone: 'attention' },
  UNKNOWN: { label: 'Desconhecido', tone: 'unknown' }
}

const LICENSE_TYPES = {
  RETAIL: 'Retail',
  VOLUME_KMS: 'Volume / KMS',
  VOLUME_MAK: 'Volume / MAK',
  SUBSCRIPTION: 'Assinatura',
  UNKNOWN: 'Desconhecido'
}

const INSTALLATION_FIELDS = [
  'id', 'source', 'productReleaseId', 'productName', 'edition', 'version', 'architecture',
  'updateChannel', 'installationTechnology', 'activationStatus', 'rawStatusCode', 'licenseType',
  'licenseName', 'licenseDescription', 'partialProductKey', 'firstSeenAt', 'lastSeenAt', 'collectedAt'
]

export function normalizeOffice(office) {
  const installations = Array.isArray(office?.installations)
    ? office.installations.map((item) => Object.fromEntries(INSTALLATION_FIELDS.map((field) => [field, item?.[field] ?? null])))
    : []
  return {
    available: office?.available === true ? true : installations.length ? true : null,
    inventoryStatus: office?.inventoryStatus || 'unknown',
    installations,
    normalized: office?.normalized || null
  }
}

export function activationStatus(status) {
  return ACTIVATION_STATUS[status] || ACTIVATION_STATUS.UNKNOWN
}

export function licenseType(type) {
  return LICENSE_TYPES[type] || LICENSE_TYPES.UNKNOWN
}

export function partialKey(value) {
  if (!value) return null
  const key = String(value).slice(-5)
  return key ? `••••• ${key}` : null
}
