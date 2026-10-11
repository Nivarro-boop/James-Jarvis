import { app } from 'electron'
import { automaticDiagnosticReport } from '@shared/diagnosticReport'
import { getSettings, onSettingsChanged } from '../store/settings'
import { getSecret } from '../secrets/keystore'
import { onIncidentRecorded } from '../selfheal'
import { AutomaticDiagnostics } from './automaticDiagnostics'
import { sendDiagnosticReport } from './diagnosticSender'
import { CapabilityGapCollector, capabilityGaps, setCapabilityGapCollector } from '../agent/capabilityGaps'

let stop: (() => void) | null = null

export function startDiagnosticMonitor(): void {
  stopDiagnosticMonitor()
  const queue = new AutomaticDiagnostics({
    config: () => getSettings().diagnosticReporting,
    send: async (count, signal) => {
      const report = automaticDiagnosticReport(app.getVersion(), process.platform, count)
      return (await sendDiagnosticReport(getSettings().diagnosticReporting, getSecret('diagnosticReportToken'), report, fetch, signal)).ok
    }
  })
  const gaps = startCapabilityGapReporter()
  let config = JSON.stringify(getSettings().diagnosticReporting)
  const stopSettings = onSettingsChanged(settings => {
    const next = JSON.stringify(settings.diagnosticReporting)
    if (next !== config) { config = next; queue.reset(); gaps.reset() }
  })
  const stopIncidents = onIncidentRecorded(({ area, code }) => queue.notify(`${area}:${code}`))
  stop = () => { stopSettings(); stopIncidents(); queue.stop(); stopCapabilityGapReporter() }
}

export function stopDiagnosticMonitor(): void { stop?.(); stop = null }

/** Fähigkeitslücken: derselbe Empfänger, aber eigene Zustimmung (`capabilityGaps`). */
export function startCapabilityGapReporter(): CapabilityGapCollector {
  const collector = new CapabilityGapCollector({
    config: () => getSettings().diagnosticReporting,
    version: app.getVersion(),
    platform: process.platform,
    send: async (report, signal) =>
      (await sendDiagnosticReport(getSettings().diagnosticReporting, getSecret('diagnosticReportToken'), report, fetch, signal)).ok
  })
  setCapabilityGapCollector(collector)
  return collector
}

export function stopCapabilityGapReporter(): void {
  capabilityGaps()?.stop()
  setCapabilityGapCollector(null)
}
