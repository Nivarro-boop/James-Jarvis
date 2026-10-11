import { useEffect, useRef, useState, type JSX } from 'react'
import type { Settings } from '@shared/types'
import { listAudioDevices } from '../audio/capture'
import { ChatGptConnection } from './ChatGptConnection'

/**
 * Die Einrichtung beim ersten Start.
 *
 * Vorher ging an dieser Stelle das volle Einstellungsfenster auf, im Abschnitt
 * „Zugänge": vierzehn Menüpunkte in der Leiste, zwölf Eingabefelder
 * untereinander, davon eines zwingend und elf optional. Wer weiß, wonach er
 * sucht, findet das sofort. Wer es nicht weiß, sieht ein Formular und schließt
 * das Fenster.
 *
 * Deshalb hier: ein Schritt pro Bild, und zwar nur die drei, ohne die es
 * wirklich nicht geht — Schlüssel, Mikrofon, Bescheid wissen. Alles andere
 * kann später kommen oder nie. Der Schlüssel wird sofort ausprobiert statt nur
 * entgegengenommen; ein halb kopierter Schlüssel fällt sonst erst auf, wenn
 * die Kugel beim ersten Ansprechen wortlos wieder ausgeht.
 */

const STEPS = ['Willkommen', 'Schlüssel', 'Mikrofon', 'Für wen', 'Fertig'] as const

/**
 * Tagesgrenze für den vorsichtigen Fall.
 *
 * Fünf Dollar sind großzügig für das, was die Grenze überhaupt erfasst — eine
 * tiefe Recherche kostet zwei bis sieben. Sie soll den Nachmittag abfangen, an
 * dem „schau mal nach" fünfmal großzügig ausgelegt wird, und nicht die normale
 * Benutzung stören.
 */
const CAREFUL_LIMIT_USD = 5

interface Props {
  settings: Settings
  patch: (p: Partial<Settings>) => Promise<Settings>
  /** Ob schon ein Gemini-Schlüssel im Speicher liegt. */
  hasKey: boolean
  /** Verlässt die Einrichtung, ohne sie als erledigt zu markieren. */
  onSkip: () => void
}

export function Setup({ settings, patch, hasKey, onSkip }: Props): JSX.Element {
  const [step, setStep] = useState(0)
  const [keyOk, setKeyOk] = useState(hasKey)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState('')

  const finish = async (): Promise<void> => {
    if (finishing) return
    setFinishing(true)
    setFinishError('')
    try {
    await patch({ setupDone: true })
    // Das Fenster gehört sich selbst — die Kugel läuft weiter und ist ab
    // jetzt ansprechbar. Ein Einstellungsfenster, das nach der Einrichtung
    // offen stehen bleibt, sieht aus, als wäre noch etwas zu tun.
    window.close()
    } catch (e) { setFinishError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.') }
    finally { setFinishing(false) }
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <ol className="setup-steps">
          {STEPS.map((label, i) => (
            <li key={label} data-state={i === step ? 'now' : i < step ? 'done' : 'todo'}>
              <span>{i < step ? '✓' : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {step === 0 && <Welcome onNext={() => setStep(1)} />}
        {step === 1 && (
          <KeyStep
            settings={settings}
            patch={patch}
            hasKey={keyOk}
            onDone={() => {
              setKeyOk(true)
              setStep(2)
            }}
          />
        )}
        {step === 2 && (
          <MicStep settings={settings} patch={patch} onNext={() => setStep(3)} />
        )}
        {step === 3 && (
          <OwnerStep settings={settings} patch={patch} onNext={() => setStep(4)} />
        )}
        {step === 4 && <DoneStep settings={settings} patch={patch} onFinish={() => { void finish() }} busy={finishing} />}
        {finishError && <p className="setup-note err">{finishError}</p>}

        <button className="setup-escape" onClick={onSkip}>
          Einrichtung überspringen und alle Einstellungen zeigen
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function Welcome({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <>
      <h1>Willkommen bei James</h1>
      <p className="setup-lede">
        James ist ein Assistent, mit dem man spricht statt tippt. Es gibt kein Chatfenster — nur
        eine leuchtende Kugel auf dem Bildschirm. Du sprichst ihn an, er antwortet laut.
      </p>
      <p className="setup-lede">
        Wähle zuerst deinen Zugang: Gemini, OpenAI API oder dein ChatGPT-Abo mit lokalen
        Ohren und lokaler Stimme. Danach folgen Mikrofon und Bedienung.
      </p>
      <div className="setup-actions">
        <button className="primary setup-go" onClick={onNext}>
          Los geht&rsquo;s
        </button>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────

function KeyStep({ hasKey, onDone, settings, patch }: {
  hasKey: boolean; onDone: () => void; settings: Settings; patch: (p: Partial<Settings>) => Promise<Settings>
}): JSX.Element {
  const [value, setValue] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'gemini' | 'openai' | 'chatgpt'>(settings.speech.provider === 'openai' ? 'openai' : settings.speech.thinkProvider === 'chatgpt' ? 'chatgpt' : 'gemini')
  const [connected, setConnected] = useState(false)
  const [localNote, setLocalNote] = useState('')
  const selection = <div className="choice-switch" role="group" aria-label="Zugang auswählen">
    {(['gemini', 'openai', 'chatgpt'] as const).map((id) => <button key={id} disabled={checking}
      className={mode === id ? 'active' : ''} onClick={() => { setMode(id); setError(null); setValue('') }}>
      {id === 'gemini' ? 'Gemini' : id === 'openai' ? 'OpenAI API' : 'ChatGPT-Abo'}
    </button>)}
  </div>

  const useSubscription = async (): Promise<void> => {
    setChecking(true)
    setError(null)
    try {
      const [ears, voice] = await Promise.all([
        window.jarvis.invoke('whisper:health'), window.jarvis.invoke('piper:health')
      ])
      if (!ears.ok || !voice.ok) throw new Error([!ears.ok ? ears.detail : '', !voice.ok ? voice.detail : ''].filter(Boolean).join(' '))
      await patch({ brainProvider: 'chatgpt', speech: { ...settings.speech,
        provider: 'piper', thinkProvider: 'chatgpt', hearProvider: 'whisper' } })
      onDone()
    } catch (e) { setError(e instanceof Error ? e.message : 'Lokale Sprachkomponenten sind nicht bereit.') }
    finally { setChecking(false) }
  }
  const installLocal = async (): Promise<void> => {
    setChecking(true)
    setError(null)
    try {
      const assets = await window.jarvis.invoke('local:assets')
      for (const asset of assets) {
        if (asset.present) continue
        setLocalNote(`${asset.label} wird geladen …`)
        await window.jarvis.invoke('local:install', { id: asset.id })
      }
      setLocalNote('Downloads abgeschlossen. Mit „Prüfen und weiter“ die Dienste testen.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Download fehlgeschlagen.') }
    finally { setChecking(false) }
  }

  if (mode === 'chatgpt') return <>
    <h1>ChatGPT-Abo und lokale Sprache</h1>{selection}
    <p className="setup-lede">Das Abo versorgt den Text-Denkmotor. Whisper hört und Piper spricht auf deinem Rechner.
      Dies ist eine Sprachunterhaltung mit einzelnen Beiträgen; die native OpenAI-Live-API wird damit nicht bezahlt.</p>
    <ChatGptConnection onChange={setConnected} model={settings.chatGptModel}
      onModelChange={(id) => patch({ chatGptModel: id })} />
    <p className="hint">Die lokalen Sprachkomponenten werden bei Bedarf aus ihren Projektquellen geladen.
      Der Download kann mehrere hundert MB umfassen. Modelle und Lizenzen stehen später unter Stimme und Ohren.</p>
    <button disabled={checking} onClick={() => void installLocal()}>Lokale Ohren und Stimme herunterladen</button>
    {localNote && <p className="hint">{localNote}</p>}
    {error && <p className="setup-note err">{error}</p>}
    <button className="primary setup-go" disabled={checking || !connected || !settings.chatGptModel}
      onClick={() => void useSubscription()}>{checking ? 'Wird geprüft …' : 'Prüfen und weiter'}</button>
  </>

  const check = async (): Promise<void> => {
    if (!value.trim() || checking) return
    setChecking(true)
    setError(null)
    try {
      const result = mode === 'openai'
        ? await window.jarvis.invoke('secrets:checkOpenai', { value })
        : await window.jarvis.invoke('secrets:checkGemini', { value })
      if (result.ok) {
        await patch({ speech: { ...settings.speech, provider: mode === 'openai' ? 'openai' : 'gemini' } })
        onDone()
      } else {
        setError(result.error ?? 'Der Schlüssel wurde nicht angenommen.')
      }
    } catch {
      setError('Die Prüfung ließ sich nicht durchführen.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <h1>{mode === 'openai' ? 'OpenAI API für Live-Sprache' : 'Der Zugang bei Google'}</h1>
      {selection}
      {mode === 'openai' ? <p className="setup-lede">Ein OpenAI API-Schlüssel ermöglicht direkte Realtime-Sprache.
        API-Guthaben und Modellzugriff sind separat vom ChatGPT-Abo.
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer"> API-Schlüssel erstellen</a>.</p> : <>
      <p className="setup-lede">
        James denkt und spricht über Googles Gemini. Dafür braucht er einen Schlüssel — eine
        lange Zeichenfolge, die es kostenlos gibt und die du dir nicht merken musst.
      </p>

      <ol className="setup-howto">
        <li>
          Öffne{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            aistudio.google.com/apikey
          </a>{' '}
          — die Seite geht in deinem Browser auf.
        </li>
        <li>Melde dich mit deinem Google-Konto an, falls gefragt wird.</li>
        <li>
          Klick auf <strong>API-Schlüssel erstellen</strong> und danach auf das Kopiersymbol
          daneben.
        </li>
        <li>Komm hierher zurück und füge ihn unten ein — Strg&nbsp;+&nbsp;V.</li>
      </ol>
      </>}

      {hasKey && mode === 'gemini' && (
        <p className="setup-note ok">
          Ein Schlüssel liegt bereits vor. Du kannst diesen Schritt überspringen.
        </p>
      )}

      <div className="field">
        <input
          type="password"
          autoFocus
          placeholder="Hier einfügen…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void check()
          }}
        />
      </div>

      {error && <p className="setup-note err">{error}</p>}

      <div className="setup-actions">
        <button className="primary setup-go" disabled={!value.trim() || checking} onClick={() => void check()}>
          {checking ? 'Wird geprüft…' : 'Prüfen und weiter'}
        </button>
        {hasKey && mode === 'gemini' && <button onClick={onDone}>Vorhandenen Zugang verwenden</button>}
      </div>

      <p className="setup-foot">
        Der Schlüssel wird verschlüsselt in deinem Windows-Benutzerkonto abgelegt und zur
        Anmeldung beim Anbieter verwendet. Die Prüfung erzeugt keine Modellantwort.
      </p>
    </>
  )
}

// ─────────────────────────────────────────────────────────────

/**
 * Mikrofonwahl mit laufendem Pegel.
 *
 * Der Balken läuft hier von allein, ohne Knopf — an dieser Stelle ist der
 * Pegel die eigentliche Antwort auf die Frage „welches Gerät nehme ich", und
 * ein Test, den man erst starten muss, wird beim Durchklicken übersprungen.
 */
function MicStep({
  settings,
  patch,
  onNext
}: {
  settings: Settings
  patch: (p: Partial<Settings>) => void
  onNext: () => void
}): JSX.Element {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [level, setLevel] = useState(0)
  const [peak, setPeak] = useState(0)
  const [denied, setDenied] = useState(false)
  const deviceId = settings.audio.inputDeviceId

  useEffect(() => {
    void listAudioDevices().then((d) => setInputs(d.inputs))
  }, [])

  // Bei jedem Gerätewechsel neu aufbauen: Ein Analyser hängt fest an dem
  // Strom, mit dem er erzeugt wurde.
  const frame = useRef(0)
  useEffect(() => {
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let stopped = false

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: settings.audio.echoCancellation,
            noiseSuppression: settings.audio.noiseSuppression,
            autoGainControl: settings.audio.autoGainControl
          }
        })
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        ctx.createMediaStreamSource(stream).connect(analyser)

        const buffer = new Float32Array(analyser.fftSize)
        const tick = (): void => {
          if (stopped) return
          analyser.getFloatTimeDomainData(buffer)
          let sum = 0
          for (const s of buffer) sum += s * s
          const next = Math.min(1, Math.sqrt(sum / buffer.length) * 4)
          setLevel(next)
          setPeak((p) => Math.max(p, next))
          frame.current = requestAnimationFrame(tick)
        }
        tick()
      } catch {
        setDenied(true)
      }
    })()

    return () => {
      stopped = true
      cancelAnimationFrame(frame.current)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [deviceId, settings.audio.echoCancellation, settings.audio.noiseSuppression, settings.audio.autoGainControl])

  return (
    <>
      <h1>Das Mikrofon</h1>
      <p className="setup-lede">
        Sag einfach irgendetwas. Der Balken muss sich bewegen — dann hört James dich. Bleibt er
        ganz links, wähl oben ein anderes Gerät.
      </p>

      <div className="field">
        <label>Gerät</label>
        <select
          value={deviceId ?? ''}
          onChange={(e) => {
            setPeak(0)
            patch({ audio: { ...settings.audio, inputDeviceId: e.target.value || null } })
          }}
        >
          <option value="">Windows-Standard</option>
          {inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Unbenanntes Gerät'}
            </option>
          ))}
        </select>
      </div>

      <div className="setup-meter">
        <div className="meter">
          <div style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
        <p className="setup-note" data-tone={denied ? 'err' : peak > 0.12 ? 'ok' : 'wait'}>
          {denied
            ? 'Windows hat den Zugriff auf das Mikrofon verweigert. Das lässt sich in den Windows-Einstellungen unter Datenschutz freigeben.'
            : peak > 0.12
              ? 'Passt — er hört dich.'
              : 'Warte auf Ton… sprich ein paar Worte.'}
        </p>
      </div>

      <div className="setup-actions">
        <button className="primary setup-go" onClick={onNext}>
          Weiter
        </button>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────

/**
 * Die einzige Sicherheitsfrage der Einrichtung.
 *
 * Die Voreinstellungen der App sind für den gedacht, der sie gebaut hat:
 * `computer_task` übernimmt Maus und Tastatur ohne Rückfrage, weil ein „darf
 * ich" vor jedem Handgriff das Werkzeug im Alltag unbrauchbar macht, und die
 * Tagesgrenze steht auf aus. Auf dem Rechner eines anderen ist beides eine
 * andere Abwägung — und derjenige, der die App dort installiert, ist selten
 * derjenige, der später die Rechnung bekommt.
 *
 * Deshalb eine Frage statt einer stillen Voreinstellung, und die Folgen stehen
 * auf dem Knopf statt im Kleingedruckten. Wer sie falsch beantwortet, findet
 * beides später unter „Rechte" und „Über" wieder.
 */
function OwnerStep({
  settings,
  patch,
  onNext
}: {
  settings: Settings
  patch: (p: Partial<Settings>) => void
  onNext: () => void
}): JSX.Element {
  const choose = (careful: boolean): void => {
    patch({
      confirmActions: careful,
      permissions: {
        ...settings.permissions,
        // Kein Eintrag hieße „Standard", und der Standard ist hier gerade das,
        // was zur Debatte steht — also in beiden Fällen ausdrücklich setzen.
        computer_task: careful ? 'ask' : 'allow'
      },
      dailyCostLimitUsd: careful ? CAREFUL_LIMIT_USD : settings.dailyCostLimitUsd
    })
    onNext()
  }

  return (
    <>
      <h1>Für wen ist dieser Rechner?</h1>
      <p className="setup-lede">
        Eine Frage noch. James kann den Bildschirm selbst bedienen — Fenster anklicken, tippen,
        ein Programm durchsteuern. Ob er dabei vorher fragt, hängt davon ab, wer hier sitzt.
      </p>

      <div className="setup-choice">
        <button onClick={() => choose(false)}>
          <strong>Für mich selbst</strong>
          <span>
            Er macht einfach. Kein „darf ich" vor jedem Handgriff — das ist schneller und der
            Grund, warum es die Bildschirmsteuerung überhaupt gibt.
          </span>
        </button>

        <button onClick={() => choose(true)}>
          <strong>Ich richte ihn für jemand anderen ein</strong>
          <span>
            Bevor er Maus und Tastatur übernimmt, fragt er laut nach. Zusätzlich stoppen tiefe
            Recherchen bei {CAREFUL_LIMIT_USD}&nbsp;$ am Tag — das ist der Posten, der wirklich
            ins Geld gehen kann.
          </span>
        </button>
      </div>

      <p className="setup-foot">
        Beides ist später umstellbar: die Rückfrage unter „Rechte", die Tagesgrenze unter „Über".
        Was James grundsätzlich nie tut — Bankfenster bedienen, Passwörter tippen, einen Kauf
        abschließen —, gilt in beiden Fällen unverändert.
      </p>
    </>
  )
}

// ─────────────────────────────────────────────────────────────

function DoneStep({
  settings,
  patch,
  onFinish,
  busy
}: {
  settings: Settings
  patch: (p: Partial<Settings>) => void
  onFinish: () => void
  busy: boolean
}): JSX.Element {
  return (
    <>
      <h1>Fertig</h1>
      <p className="setup-lede">Ab jetzt reagiert er. Es gibt drei Wege, ihn anzusprechen:</p>

      <ul className="setup-ways">
        <li>
          <strong>„Hey James"</strong> sagen — er hört immer mit, aber nur auf diese zwei Wörter,
          und das passiert auf diesem Rechner, nicht im Internet.
        </li>
        <li>
          <strong>Alt&nbsp;+&nbsp;Leertaste</strong> drücken — geht auch, wenn ein anderes
          Programm im Vordergrund ist.
        </li>
        <li>
          <strong>Die Kugel anklicken.</strong> Nochmal klicken legt ihn still, wenn Ruhe sein
          soll.
        </li>
      </ul>

      <p className="setup-lede">
        Kommt er einmal durcheinander: dreimal <strong>Esc</strong> bricht sofort alles ab.
      </p>

      <div className="field">
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={settings.launchOnStartup}
            onChange={(e) => patch({ launchOnStartup: e.target.checked })}
            style={{ width: 'auto', marginRight: 8 }}
          />
          James beim Anmelden mitstarten
        </label>
        <div className="hint" style={{ marginLeft: 24 }}>
          Empfohlen. Er kommt dann ohne Fenster hoch, nur mit dem kleinen Symbol unten rechts
          neben der Uhr.
        </div>
      </div>

      <div className="setup-actions">
        <button className="primary setup-go" disabled={busy} onClick={onFinish}>
          Fenster schließen und loslegen
        </button>
      </div>

      <p className="setup-foot">
        Die Einstellungen erreichst du jederzeit über das Zahnrad oben rechts im Fenster oder
        einen Rechtsklick auf das Symbol neben der Uhr.
      </p>
    </>
  )
}
