import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'

/**
 * Ein Befehl auf der PowerShell.
 *
 * Das ist das offenste Werkzeug im ganzen Haus, und deshalb das mit den
 * meisten Riegeln: es fragt immer nach (in permissions.ts fest verdrahtet,
 * nicht abschaltbar), es steht im Aktionslog, und die Liste unten lehnt ab,
 * was sich nicht zurücknehmen lässt oder nach Schadsoftware aussieht.
 *
 * Warum es überhaupt existiert: für alles, wofür es kein eigenes Werkzeug
 * gibt und wofür die Bildschirmsteuerung der falsche Weg wäre — einen Dienst
 * neu starten, eine Datei umbenennen, kurz nachsehen, was ein Prozess treibt.
 * Über Bildschirmfotos wäre das ein Dutzend Schritte und drei Minuten.
 */

/**
 * Was nicht durchgeht.
 *
 * Zwei Sorten: Dinge, die den Rechner beschädigen oder Spuren verwischen
 * (Partitionen, Startkonfiguration, Schattenkopien, Virenschutz), und Muster,
 * die es außerhalb von Schadsoftware praktisch nicht gibt — etwas aus dem Netz
 * laden und sofort ausführen, oder einen Befehl in Base64 verstecken.
 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /\bformat\s+[a-z]:/i, why: 'formatiert ein Laufwerk' },
  { pattern: /\bdiskpart\b|\bbcdedit\b|\bbootrec\b/i, why: 'greift Partitionen oder den Start an' },
  { pattern: /vssadmin\s+delete|wbadmin\s+delete/i, why: 'löscht Sicherungen' },
  { pattern: /cipher\s+\/w/i, why: 'überschreibt freien Plattenplatz' },
  {
    pattern: /remove-item[^|]*-recurse[^|]*(-force)?[^|]*\b[a-z]:\\(\s|$|['"])/i,
    why: 'löscht ein ganzes Laufwerk'
  },
  { pattern: /\b(rd|rmdir)\s+\/s|\bdel\s+\/[sq]/i, why: 'löscht rekursiv ohne Rückfrage' },
  { pattern: /set-mppreference|add-mppreference|netsh\s+advfirewall/i, why: 'schaltet Schutz ab' },
  { pattern: /\breg\s+(add|delete)\b|hklm:\\/i, why: 'schreibt in die Registry' },
  { pattern: /\bnet\s+(user|localgroup)\b/i, why: 'ändert Benutzerkonten' },
  { pattern: /-encodedcommand|frombase64string/i, why: 'versteckt seinen Inhalt' },
  {
    pattern: /(invoke-expression|\biex\b)|((irm|iwr|invoke-webrequest|curl|wget)[^|]*\|)/i,
    why: 'lädt etwas und führt es sofort aus'
  },
  { pattern: /secrets\.bin|google-tokens\.bin|id_rsa|\\\.ssh\\/i, why: 'liest Zugangsdaten' },
  { pattern: /mimikatz|get-credential|convertfrom-securestring/i, why: 'greift Anmeldedaten ab' }
]

const MAX_OUTPUT = 3000
const TIMEOUT_MS = 60_000

const runCommand = defineTool({
  name: 'run_command',
  group: 'system',
  description:
    'Führt einen PowerShell-Befehl aus und liefert die Ausgabe. Letztes Mittel — nimm zuerst die ' +
    'eigenen Werkzeuge: open_app, file_find, system_status, arrange_window. Passend für Dinge, ' +
    'für die es kein Werkzeug gibt, etwa einen Dienst neu starten oder Dateien umbenennen. ' +
    'Fragt immer nach, bevor etwas läuft.',
  schema: z.object({
    command: z.string().describe('Der Befehl, wie man ihn in die PowerShell tippen würde.'),
    workDir: z.string().optional().describe('Arbeitsverzeichnis, falls es darauf ankommt.'),
    purpose: z.string().describe('Was der Befehl bewirken soll — für die Rückfrage an den Nutzer.')
  }),
  async execute({ command, workDir, purpose }, ctx) {
    const trimmed = command.trim()
    if (!trimmed) throw new Error('Kein Befehl angegeben.')

    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(trimmed)) {
        throw new Error(
          `Diesen Befehl führe ich nicht aus — er ${why}. Sag dem Nutzer, dass er das selbst machen muss.`
        )
      }
    }

    if (workDir && !existsSync(workDir)) {
      throw new Error('Das Arbeitsverzeichnis gibt es nicht.')
    }

    ctx.setState('tool')

    const { stdout, stderr, code } = await new Promise<{
      stdout: string
      stderr: string
      code: number
    }>((done) => {
      // Dreimal Escape bricht alles ab — auch einen Befehl, der hängt. Der
      // Horcher wird danach wieder abgemeldet: das Abbruchsignal lebt so lange
      // wie die App, und ein Horcher pro Befehl summiert sich sonst bis zur
      // MaxListenersExceededWarning.
      let abort: (() => void) | null = null

      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', trimmed],
        { cwd: workDir, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, out, err) => {
          if (abort) ctx.signal.removeEventListener('abort', abort)
          done({
            stdout: String(out ?? ''),
            stderr: String(err ?? ''),
            // execFile meldet den Abbruch über ein Signal statt über den Code.
            code: error && 'code' in error ? Number(error.code ?? 1) : error ? 1 : 0
          })
        }
      )

      abort = (): void => {
        child.kill()
      }
      ctx.signal.addEventListener('abort', abort, { once: true })
    })

    const clip = (text: string): string =>
      text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}…` : text

    return {
      zweck: purpose,
      code,
      ausgabe: clip(stdout.trim()) || '(keine Ausgabe)',
      fehler: stderr.trim() ? clip(stderr.trim()) : undefined,
      hinweis:
        code === 0
          ? 'Sag in einem Satz, was dabei herauskam. Lies keine Tabellen und keine Pfade vor.'
          : 'Der Befehl ist fehlgeschlagen. Sag kurz woran es lag, ohne die Fehlermeldung vorzulesen.'
    }
  }
}) as ToolDefinition

export const shellTools: ToolDefinition[] = [runCommand]
