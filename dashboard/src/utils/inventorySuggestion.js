export function hostnameEquipmentSuggestion(hostname) {
  const value = String(hostname || '').trim()
  const match = value.match(/(\d{1,3})$/)
  return match ? match[1] : null
}
