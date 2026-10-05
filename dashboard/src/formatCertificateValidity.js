function formatDate(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

export function formatCertificateValidity(certificate) {
  const date = formatDate(certificate.validadeFim)
  switch (certificate.statusValidade) {
    case 'VALIDO_CONFIRMADO':
      return { label: date ? `Validade: ${date}` : 'Validade ainda não identificada', tone: 'confirmed', detail: null }
    case 'VENCIDO_CONFIRMADO':
      return { label: date ? `Vencido em ${date}` : 'Vencido', tone: 'confirmed-expired', detail: null }
    case 'VALIDADE_ESTIMADA':
      return { label: date ? `Possível validade: ${date}` : 'Possível validade não identificada', tone: 'estimated', detail: 'Estimativa baseada na data do arquivo' }
    case 'POSSIVELMENTE_VENCIDO':
      return { label: date ? `Possivelmente vencido em ${date}` : 'Possivelmente vencido', tone: 'estimated-expired', detail: 'Data estimada' }
    case 'AMBIGUA':
      return { label: 'Validade precisa de conferência', tone: 'ambiguous', detail: null }
    default:
      return { label: 'Validade ainda não identificada', tone: 'unknown', detail: null }
  }
}
