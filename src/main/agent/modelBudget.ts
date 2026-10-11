import { AsyncLocalStorage } from 'node:async_hooks'

interface Budget { calls: number; limit: number; updated: number }
const scope = new AsyncLocalStorage<Budget>()
const budgets = new Map<string, Budget>()
export const SAVER_MODEL_CALLS = 12

/** A turn and all of its nested tools/workers share one admission counter. */
export function withModelBudget<T>(id: string, saver: boolean, operation: () => T): T {
  if (scope.getStore()) return operation()
  const now = Date.now()
  for (const [key, value] of budgets) if (now - value.updated > 600_000) budgets.delete(key)
  let budget = budgets.get(id)
  if (!budget) {
    if (budgets.size >= 128) budgets.delete(budgets.keys().next().value!)
    budget = { calls: 0, limit: saver ? SAVER_MODEL_CALLS : Infinity, updated: now }
    budgets.set(id, budget)
  }
  return scope.run(budget, operation)
}

export function consumeModelCall(): void {
  const budget = scope.getStore()
  if (!budget) return
  budget.updated = Date.now()
  if (budget.calls >= budget.limit) throw new Error(`Sparlimit: ${budget.limit} Modellaufrufe für diesen Auftrag erreicht. Der Auftrag ist noch nicht abgeschlossen; gib den Zwischenstand zurück.`)
  budget.calls++
}
