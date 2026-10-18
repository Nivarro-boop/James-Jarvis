/**
 * Support-Meldung: Was ist passiert, plus auf Wunsch technische Angaben.
 *
 * Die Meldung geht nie von selbst raus. Der Nutzer öffnet sie im eigenen
 * Mailprogramm oder als GitHub-Issue und schickt sie selbst ab, oder kopiert
 * den Text. Die technischen Angaben enthalten nur Version, System und die
 * Kennungen offener Störungen — keine Logzeilen, Pfade, Schlüssel oder
 * Gesprächsinhalte.
 */

export const SUPPORT_ISSUE_URL = 'https://github.com/Nivarro-boop/James-Jarvis/issues/new'

/** mailto-Adressen werden von manchen Mailprogrammen über dieser Länge abgeschnitten. */
export const MAILTO_MAX = 1900

export interface SupportDiagnostics {
  version: string
  platform: string
  arch: string
  problems: { area: string; code: string; count: number }[]
  healed: number
}

export interface SupportReport {
  subject: string
  body: string
}

const clean = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').trim()

export function buildSupportReport(beschreibung: string, diag: SupportDiagnostics | null): SupportReport {
  const text = beschreibung.trim().slice(0, 4000) || '(noch keine Beschreibung)'
  const first = clean(text).slice(0, 60)
  const subject = `James-Jarvis: ${first}${clean(text).length > 60 ? ' …' : ''}`
  const lines = ['Hallo,', '', 'was ist passiert:', text, '']
  if (diag) {
    lines.push(
      'Technische Angaben:',
      `- Version: ${clean(diag.version)}`,
      `- System: ${clean(diag.platform)} ${clean(diag.arch)}`,
      `- Selbst behoben (24 h): ${Math.max(0, Math.floor(diag.healed))}`
    )
    if (diag.problems.length === 0) lines.push('- Offene Störungen: keine')
    else {
      lines.push('- Offene Störungen:')
      for (const p of diag.problems.slice(0, 20)) lines.push(`  - ${clean(p.area)} / ${clean(p.code)} (${Math.max(0, Math.floor(p.count))}×)`)
    }
    lines.push('')
  }
  return { subject, body: lines.join('\n') }
}

export function supportMailto(report: SupportReport, to = ''): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(report.subject)}&body=${encodeURIComponent(report.body)}`
}

export function supportIssueUrl(report: SupportReport): string {
  const p = new URLSearchParams({ title: report.subject, body: report.body })
  return `${SUPPORT_ISSUE_URL}?${p.toString()}`
}
