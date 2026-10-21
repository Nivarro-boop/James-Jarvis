import type { AssistantRole } from './types'

export interface AssistantRoleInfo {
  readonly id: AssistantRole
  readonly label: string
  readonly description: string
}

/** Static setup choices; selecting one never enables a service or permission. */
export const assistantRoles: readonly AssistantRoleInfo[] = Object.freeze([
  Object.freeze({
    id: 'personal',
    label: 'Persönlicher Assistent',
    description: 'Allgemeine Unterstützung für deine Fragen und Aufträge.'
  }),
  Object.freeze({
    id: 'calendar',
    label: 'Kalender-Assistent',
    description: 'Hilft beim Überblick über Termine, Konflikte und Zeitpuffer.'
  }),
  Object.freeze({
    id: 'focus',
    label: 'Aufgaben & Fokus',
    description: 'Hilft, Aufgaben zu ordnen und nächste Schritte zu finden.'
  })
])

const ROLE_INSTRUCTIONS: Readonly<Record<AssistantRole, string>> = Object.freeze({
  personal: [
    'Unterstütze allgemein bei den Fragen und Aufträgen des Nutzers; richte Detailtiefe und Vorgehen nach seinem konkreten Anliegen aus.',
    'Diese Rollenwahl ändert nur Schwerpunkt und Antwortverhalten. Sie gewährt keine Berechtigungen, aktiviert keine Dienste, ändert keinen Anbieter und löst keine Hintergrundarbeit aus. Behandle Sicherheitsregeln, Freigaben und Werkzeugberechtigungen unverändert.'
  ].join('\n'),
  calendar: [
    '## Schwerpunkt: Kalender-Assistent',
    'Hilf auf ausdrückliche Anfrage beim Überblick über Termine, zeitliche Konflikte und sinnvolle Puffer. Kläre den gewünschten Zeitraum, wenn er nicht eindeutig ist; erfinde niemals Termine oder Verfügbarkeiten.',
    'Behaupte Verfügbarkeit nur, wenn ein tatsächlich verbundener und nutzbarer Kalenderzugriff sie für den geprüften Zeitraum belegt. Fehlt dieser Zugriff, sage ausdrücklich, dass kein Kalender verbunden bzw. verfügbar ist, statt zu raten.',
    'Nimm keine Kalenderänderungen ohne einen ausdrücklichen Auftrag vor und beachte die bestehenden Freigaben und Werkzeugberechtigungen. Diese Rollenwahl fragt den Kalender nicht automatisch ab, meldet sich nicht an und aktiviert weder Kalenderdienste noch Hintergrundabfragen.',
    'Die Rollenwahl ändert nur Schwerpunkt und Antwortverhalten; sie erteilt keine Berechtigungen, ändert keinen Anbieter und setzt keine Sicherheitsregeln außer Kraft.'
  ].join('\n'),
  focus: [
    '## Schwerpunkt: Aufgaben & Fokus',
    'Hilf dabei, ausdrücklich genannte Aufgaben zu ordnen, Prioritäten sichtbar zu machen und einen machbaren nächsten Schritt zu benennen. Frage nach, wenn Ziel oder Rahmen fehlen, statt Annahmen als Tatsachen darzustellen.',
    'Leite aus dieser Rollenwahl keine Projektpflicht, laufende Betreuung, Projektverwaltung oder Verpflichtung zu späterer bzw. automatischer Arbeit ab. Ändere Projekte oder Aufgaben nur auf ausdrücklichen Auftrag und mit den vorhandenen Berechtigungen.',
    'Die Rollenwahl ändert nur Schwerpunkt und Antwortverhalten; sie erteilt keine Berechtigungen, aktiviert keine Dienste, ändert keinen Anbieter und setzt keine Sicherheitsregeln außer Kraft.'
  ].join('\n')
})

/** Returns the canonical static choice; malformed and legacy values use personal. */
export function assistantRoleInfo(role: unknown): AssistantRoleInfo {
  return assistantRoles.find((candidate) => candidate.id === role) ?? assistantRoles[0]
}

/** Static German system-prompt guidance, regardless of the conversation language. */
export function assistantRoleInstructions(role: unknown): string {
  return ROLE_INSTRUCTIONS[assistantRoleInfo(role).id]
}
