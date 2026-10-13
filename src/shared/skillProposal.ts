export interface SkillProposal {
  id: string
  name: string
  description: string
  steps: string
  previous: string | null
  source: 'auto' | 'manual'
}
