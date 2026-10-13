import { randomUUID } from 'node:crypto'
import type { SkillProposal } from '@shared/skillProposal'
import { findSkill, saveSkill } from './skills'
import { broadcast } from '../ipc/emit'

const pending: SkillProposal[] = []
export function skillProposals(): SkillProposal[] { return pending.map(p => ({ ...p })) }
export function proposeSkill(input: Pick<SkillProposal, 'name' | 'description' | 'steps' | 'source'>): SkillProposal {
  if (!input.name.trim() || !input.steps.trim() || input.steps.length > 6000) throw new Error('Ungültiger Fertigkeitsvorschlag.')
  const existing = findSkill(input.name)
  const proposal: SkillProposal = { ...input, name: existing?.name ?? input.name.trim(), id: randomUUID(), previous: existing?.steps ?? null }
  const index = pending.findIndex(p => p.name.toLowerCase() === proposal.name.toLowerCase())
  if (index >= 0) pending.splice(index, 1)
  if (pending.length >= 10) pending.shift()
  pending.push(proposal)
  broadcast('skills:proposed', skillProposals())
  return proposal
}
export function decideSkill(id: string, accept: boolean): void {
  const index = pending.findIndex(p => p.id === id)
  if (index < 0) throw new Error('Dieser Vorschlag ist nicht mehr verfügbar.')
  const proposal = pending[index]
  if (accept) {
    if ((findSkill(proposal.name)?.steps ?? null) !== proposal.previous) throw new Error('Die Fertigkeit wurde inzwischen geändert. Bitte einen neuen Vorschlag erstellen lassen.')
    saveSkill(proposal)
  }
  pending.splice(index, 1)
  broadcast('skills:proposed', skillProposals())
}
