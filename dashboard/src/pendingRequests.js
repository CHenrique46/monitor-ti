export const PENDING_REQUESTS_STORAGE_KEY = 'henritech.pending-request-notification'

export function requestMarker(summary) {
  if (summary?.ultimaSolicitacaoId == null && !summary?.ultimaSolicitacaoEm) return null
  return {
    id: summary?.ultimaSolicitacaoId ?? null,
    timestamp: summary?.ultimaSolicitacaoEm ?? null
  }
}

export function markerKey(marker) {
  return marker ? `${marker.id ?? ''}:${marker.timestamp ?? ''}` : ''
}

export function shouldNotify(previousCount, nextSummary, previousMarker, storedMarker) {
  const nextMarker = requestMarker(nextSummary)
  return Boolean(
    previousCount != null &&
    nextSummary?.pendentes > previousCount &&
    nextMarker &&
    markerKey(nextMarker) !== markerKey(previousMarker) &&
    markerKey(nextMarker) !== markerKey(storedMarker)
  )
}
