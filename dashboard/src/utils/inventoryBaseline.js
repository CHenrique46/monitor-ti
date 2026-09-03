export function canAddInventory(comparison) {
  return comparison?.hasBaseline === false
}

export function buildInventoryBaselinePayload({ equipamentoNumero, apelido }) {
  return { equipamentoNumero, apelido }
}
