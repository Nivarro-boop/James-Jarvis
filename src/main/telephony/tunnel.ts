import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { tailnetName, tailscaleExecutable } from '../companion/tailscale'

const execFileAsync = promisify(execFile)

/**
 * Der Weg von außen nach innen.
 *
 * Twilio muss diesen Rechner erreichen können, sonst gibt es kein Gespräch —
 * es holt sich beim Abheben die Anweisung ab und öffnet danach den
 * Medienstrom. Beides geht nur über eine öffentliche Adresse mit gültigem
 * Zertifikat.
 *
 * Drei Wege stehen zur Wahl, in dieser Reihenfolge:
 *
 *   1. Manuell eingetragene URL — wer cloudflared, ngrok oder eine feste
 *      Adresse hat, trägt sie in den Einstellungen ein. Diese Datei fasst
 *      dann nichts an.
 *
 *   2. Tailscale Funnel — wenn Tailscale installiert und angemeldet ist,
 *      schaltet James Funnel für den Telefon-Port ein.
 *
 *   3. cloudflared Quick-Tunnel — wenn Tailscale fehlt, aber cloudflared
 *      installiert ist, startet James einen temporären Tunnel. Die Adresse
 *      gilt nur solange die App läuft, was für Gespräche vollkommen reicht.
 *
 * Einen Port im Router aufzumachen wäre der naheliegende Weg und der falsche.
 * Dahinter säße ein Dienst, der auf Kosten des Twilio-Kontos telefonieren
 * kann, dauerhaft sichtbar für jeden Scanner im Netz. Ein Tunnel dreht die
 * Richtung um: Die Verbindung geht von hier nach draußen, es gibt keinen
 * offenen Port, und abschalten heißt wirklich abschalten.
 */

export interface TunnelState {
  /** Öffentliche Basisadresse, etwa `https://rechner.taile1234.ts.net`. */
  publicUrl: string | null
  /** Woher sie kommt. */
  source: 'tailscale' | 'cloudflared' | 'manuell' | null
  /** Was fehlt, in ganzen Sätzen. */
  hint?: string
}

// ─────────────────────────────────────────────────────────────
// Tailscale Funnel
// ─────────────────────────────────────────────────────────────

async function runTailscale(args: string[]): Promise<string> {
  const exe = tailscaleExecutable()
  if (!exe) throw new Error('Tailscale ist auf diesem Rechner nicht installiert.')
  const { stdout } = await execFileAsync(exe, args, { windowsHide: true, maxBuffer: 1024 * 1024 })
  return stdout
}

/**
 * Funnel für einen lokalen Port einschalten.
 *
 * `--bg` heißt: im Hintergrund weiterlaufen, statt den Tunnel an die Laufzeit
 * des Befehls zu binden.
 */
export async function startFunnel(port: number): Promise<TunnelState> {
  const host = await tailnetName()
  if (!host) {
    return {
      publicUrl: null,
      source: null,
      hint:
        'Tailscale läuft nicht oder ist nicht angemeldet. Ohne Tailnet-Namen gibt es keine ' +
        'öffentliche Adresse — melde dich einmal an, MagicDNS muss eingeschaltet sein.'
    }
  }

  try {
    await runTailscale(['funnel', '--bg', String(port)])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const link = message.match(/https:\/\/login\.tailscale\.com\S+/)?.[0]
    return {
      publicUrl: null,
      source: null,
      hint: link
        ? `Funnel ist in deinem Tailnet noch nicht freigegeben. Einmal hier bestätigen: ${link}`
        : `Funnel ließ sich nicht einschalten: ${message.slice(0, 300)}`
    }
  }

  funnelOpenedByUs = true
  return { publicUrl: `https://${host}`, source: 'tailscale' }
}

/**
 * Ob James in diesem Lauf einen Funnel aufgemacht hat.
 *
 * Nur dann wird er beim Beenden wieder zugemacht. Vorher lief
 * `funnel --https=443 off` bei jedem Beenden der App — auch bei jemandem, der
 * nie telefoniert hat und über Funnel etwas ganz anderes freigibt.
 */
let funnelOpenedByUs = false

export async function stopFunnel(): Promise<void> {
  if (!funnelOpenedByUs) return
  funnelOpenedByUs = false
  try {
    await runTailscale(['funnel', '--https=443', 'off'])
  } catch (err) {
    console.info('[telefonie] Funnel-Abschaltung:', String(err).slice(0, 200))
  }
}

// ─────────────────────────────────────────────────────────────
// cloudflared Quick-Tunnel
// ─────────────────────────────────────────────────────────────

let cloudflaredProcess: ChildProcess | null = null
let cloudflaredUrl: string | null = null
/** Der Port, auf den der laufende Tunnel zeigt. */
let cloudflaredPort = 0
/** Ein Start, der gerade läuft — gleichzeitige Aufrufer warten auf ihn. */
let cloudflaredStarting: Promise<TunnelState> | null = null

/**
 * Findet cloudflared auf dem System.
 *
 * Schaut zuerst in PATH, dann an den üblichen Windows-Installationsorten.
 */
async function findCloudflared(): Promise<string | null> {
  const candidates = [
    'cloudflared',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    // Die Umgebungswege nur, wenn sie gesetzt sind — sonst stünde hier
    // wörtlich "undefined\cloudflared\cloudflared.exe", und der Versuch
    // scheiterte erst nach der Zeitüberschreitung statt sofort.
    ...(process.env.LOCALAPPDATA ? [`${process.env.LOCALAPPDATA}\\cloudflared\\cloudflared.exe`] : []),
    ...(process.env.USERPROFILE ? [`${process.env.USERPROFILE}\\.cloudflared\\cloudflared.exe`] : [])
  ]

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['--version'], { windowsHide: true, timeout: 3000 })
      return candidate
    } catch {
      // Nicht dort — weitersuchen.
    }
  }
  return null
}

/**
 * cloudflared Quick-Tunnel starten.
 *
 * Ein Quick-Tunnel braucht keinen Cloudflare-Account. Er öffnet eine temporäre
 * *.trycloudflare.com-Adresse, die genau so lange gilt wie der Prozess läuft.
 * Das ist für Twilio-Gespräche vollkommen ausreichend.
 */
export async function startCloudflaredTunnel(port: number): Promise<TunnelState> {
  // Wenn schon einer auf diesen Port läuft, die bestehende Adresse
  // weiterverwenden. Zeigt er auf einen anderen, führte seine Adresse ins
  // Leere — dann wird er ersetzt.
  if (cloudflaredProcess && cloudflaredUrl) {
    if (cloudflaredPort === port) return { publicUrl: cloudflaredUrl, source: 'cloudflared' }
    stopCloudflaredTunnel()
  }
  // Telefonie und Alexa fragen beim Hochfahren gleichzeitig. Zwei Starts
  // hießen zwei Prozesse, und `stopCloudflaredTunnel` kennt nur den letzten.
  cloudflaredStarting ??= launchCloudflared(port).finally(() => {
    cloudflaredStarting = null
  })
  return cloudflaredStarting
}

async function launchCloudflared(port: number): Promise<TunnelState> {
  const exe = await findCloudflared()
  if (!exe) {
    return {
      publicUrl: null,
      source: null,
      hint:
        'Weder Tailscale noch cloudflared sind installiert. ' +
        'Für Twilio-Gespräche wird ein Tunnel gebraucht. ' +
        'Entweder cloudflared installieren (cloudflared.com/downloads), ' +
        'oder Tailscale, oder eine manuelle HTTPS-URL in den Einstellungen eintragen.'
    }
  }

  return new Promise((resolve) => {
    let resolved = false

    const child = spawn(exe, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
      windowsHide: true,
      // stderr: cloudflared schreibt die URL auf stderr
      stdio: ['ignore', 'pipe', 'pipe']
    })

    cloudflaredProcess = child

    // Steht vor `giveUp`, weil der es abräumt. Gesetzt wird er gleich darunter.
    let timeout: NodeJS.Timeout | undefined

    /**
     * Aufgeben — und dabei den Prozess mitnehmen.
     *
     * Das Mitnehmen ist der Punkt. Ohne es blieb nach einer Zeitüberschreitung
     * ein cloudflared am Leben, das keine Adresse gemeldet hatte: `resolved`
     * war gesetzt, `cloudflaredUrl` blieb leer, und weil der Wächter ganz oben
     * beides verlangt, startete der nächste Versuch einen zweiten Prozess und
     * überschrieb den Zeiger auf den ersten. Der war damit für immer verloren —
     * `stopCloudflaredTunnel` kennt nur den letzten. Bei jedem Anlauf einer
     * mehr, alle mit offener Verbindung nach draußen, bis die App endet.
     */
    const giveUp = (hint: string): void => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      if (cloudflaredProcess === child) {
        cloudflaredProcess = null
        cloudflaredUrl = null
      }
      try {
        child.kill()
      } catch {
        // Wenn er ohnehin schon weg ist, ist nichts zu tun.
      }
      resolve({ publicUrl: null, source: null, hint })
    }

    timeout = setTimeout(
      () =>
        giveUp(
          'cloudflared hat in 20 Sekunden keine öffentliche Adresse gemeldet. Prüfe, ob es korrekt installiert ist.'
        ),
      20_000
    )

    const onData = (data: Buffer): void => {
      const text = data.toString()

      // cloudflared schreibt: "Your quick Tunnel has been created! Visit it at:"
      // gefolgt von der URL — oder direkt: https://xxxx.trycloudflare.com.
      // Nur diese Endung: `*.cfargotunnel.com` taucht im Protokoll auch auf,
      // ist aber bloß ein DNS-Ziel und nimmt selbst keine Anrufe an.
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (match && !resolved) {
        resolved = true
        clearTimeout(timeout)
        cloudflaredUrl = match[0]
        cloudflaredPort = port
        resolve({ publicUrl: cloudflaredUrl, source: 'cloudflared' })
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('error', (err) => giveUp(`cloudflared konnte nicht gestartet werden: ${err.message}`))

    child.on('exit', () => {
      // Nur aufräumen, wenn dieser Prozess noch der aktuelle ist. Sonst löschte
      // das Ende eines alten die Adresse eines neuen, der gerade läuft.
      if (cloudflaredProcess !== child) return
      cloudflaredProcess = null
      cloudflaredUrl = null
    })
  })
}

export function stopCloudflaredTunnel(): void {
  if (cloudflaredProcess) {
    try {
      cloudflaredProcess.kill()
    } catch {
      // Wenn der Prozess schon weg ist, ist das ok.
    }
    cloudflaredProcess = null
    cloudflaredUrl = null
  }
}

// ─────────────────────────────────────────────────────────────
// Öffentliche Schnittstelle
// ─────────────────────────────────────────────────────────────

/**
 * Die öffentliche Adresse besorgen — von Hand eingetragen, über Tailscale,
 * oder über cloudflared Quick-Tunnel.
 *
 * Die von Hand eingetragene hat Vorrang. Tailscale kommt als zweites, weil es
 * für viele Nutzer ohnehin da ist. cloudflared ist der Fallback für alle, die
 * ohne Tailscale auskommen wollen.
 */
export async function ensurePublicUrl(manualUrl: string, port: number): Promise<TunnelState> {
  const manual = manualUrl.trim().replace(/\/+$/, '')
  if (manual) {
    if (!manual.startsWith('https://')) {
      return {
        publicUrl: null,
        source: null,
        hint: 'Die Adresse muss mit https:// anfangen — Twilio nimmt nichts Unverschlüsseltes an.'
      }
    }
    return { publicUrl: manual, source: 'manuell' }
  }

  // Tailscale versuchen — wenn installiert, ist das die stabilste Option.
  // `startFunnel` prüft selbst, ob ein Tailnet-Name herauskommt, und meldet
  // es als Hinweis zurück; hier vorher noch einmal nachzufragen hieße, denselben
  // Befehl zweimal laufen zu lassen.
  if (tailscaleExecutable()) {
    const funnel = await startFunnel(port)
    if (funnel.publicUrl) return funnel

    // Installiert heißt nicht benutzbar. Der mit Abstand häufigste Fall ist,
    // dass Funnel im Tailnet gar nicht freigeschaltet ist — `startFunnel`
    // fischt dafür eigens den Freischalt-Link aus Tailscales Ausgabe. Vorher
    // war das das Ende: cloudflared lag daneben, installiert und ungenutzt,
    // weil der Rückfall nur an "Tailscale fehlt" hing und nicht an
    // "Tailscale kann es nicht".
    const fallback = await startCloudflaredTunnel(port)
    if (fallback.publicUrl) {
      console.info('[telefonie] Funnel ging nicht, cloudflared hat übernommen:', funnel.hint)
      return fallback
    }

    // Beide daneben. Dann zählt der Hinweis von Tailscale mehr: Er enthält
    // meist den Link, mit dem sich das in einer Minute beheben lässt.
    return funnel
  }

  // Fallback: cloudflared Quick-Tunnel
  return startCloudflaredTunnel(port)
}
