/** The receiver's four-field contract, without arbitrary log text. */
export function diagnosticReport(version: string, platform: string, problems: number, healed: number) {
  const count = Math.max(0, Math.floor(problems))
  return {
    level: count > 0 ? 'error' : 'info',
    message: count > 0 ? 'JARVIS: unresolved technical incidents' : 'JARVIS: technical status check',
    source: 'JARVIS',
    details: JSON.stringify({ appVersion: version, platform, problems: count, healed: Math.max(0, Math.floor(healed)) })
  }
}

/** Automatic uploads use only aggregate counters, never incident text or fingerprints. */
export function automaticDiagnosticReport(version: string, platform: string, incidents: number) {
  return {
    level: 'error',
    message: 'JARVIS: automatic anonymized technical incident report',
    source: 'JARVIS',
    details: JSON.stringify({ appVersion: version, platform, incidents: Math.max(0, Math.floor(incidents)), automatic: true })
  }
}
