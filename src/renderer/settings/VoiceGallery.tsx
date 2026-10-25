import { useEffect, useRef, useState, type JSX } from 'react'
import type { ElevenVoice, SecretKey, Settings } from '@shared/types'
import {
  GALLERY_PROVIDER_LABELS,
  VOICE_GALLERY,
  activeGalleryVoice,
  galleryPatch,
  type GalleryVoice
} from '@shared/voiceGallery'

/** Kurz, mit Zahl und Frage: Daran hört man Klarheit und Betonung am besten. */
const SAMPLE = 'Hallo, ich bin James. Morgen wird es sonnig bei einundzwanzig Grad. Soll ich dich um sieben wecken?'

const NEEDS: Partial<Record<GalleryVoice['provider'], SecretKey>> = { gemini: 'gemini', openai: 'openai', elevenlabs: 'elevenlabs' }

/**
 * Stimmen-Galerie: klare Assistentenstimmen zum Anhören und Auswählen.
 *
 * Siris eigene Stimme gibt es nur auf Apple-Geräten. Die Galerie stellt die
 * Stimmen zusammen, die ihr am nächsten kommen, und stellt sie auf eine saubere,
 * ruhige Sprechweise ein. Feinregler bleiben darunter erhalten.
 */
export function VoiceGallery({ settings, patch, present }: {
  settings: Settings
  patch: (p: Partial<Settings>) => Promise<Settings>
  present: (key: SecretKey) => boolean
}): JSX.Element {
  const [playing, setPlaying] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [elevenVoices, setElevenVoices] = useState<ElevenVoice[] | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const active = activeGalleryVoice(settings)

  useEffect(() => () => { audio.current?.pause() }, [])

  const elevenId = async (entry: GalleryVoice): Promise<string> => {
    let voices = elevenVoices
    if (!voices) {
      voices = await window.jarvis.invoke('eleven:voices').catch(() => [] as ElevenVoice[])
      setElevenVoices(voices)
    }
    return voices.find((v) => v.name.toLowerCase().startsWith(entry.voice.toLowerCase()))?.id ?? entry.elevenId ?? ''
  }

  const play = (base64: string, mime: string, id: string): Promise<void> => {
    const raw = atob(base64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    audio.current?.pause()
    const element = new Audio(url)
    audio.current = element
    const done = (): void => { URL.revokeObjectURL(url); setPlaying((now) => (now === id ? null : now)) }
    element.onended = done
    element.onerror = done
    return element.play()
  }

  const listen = async (entry: GalleryVoice): Promise<void> => {
    if (playing) return
    setPlaying(entry.id)
    setNote(null)
    let started = false
    try {
      if (entry.provider === 'piper') {
        setNote({ ok: true, text: 'Lokale Stimmen erst wählen; danach spricht „Probe hören“ unter Persönlichkeit im Hauptfenster.' })
        return
      }
      const result = entry.provider === 'elevenlabs'
        ? await window.jarvis.invoke('eleven:preview', { voiceId: await elevenId(entry), text: SAMPLE }).then((r) => ({ ...r, mime: 'audio/mpeg' as const }))
        : await window.jarvis.invoke('voice:preview', { provider: entry.provider, voice: entry.voice, text: SAMPLE })
      if (!result.ok || !result.audio) { setNote({ ok: false, text: result.error ?? 'Die Hörprobe ging nicht.' }); return }
      await play(result.audio, result.mime ?? 'audio/mpeg', entry.id)
      started = true
    } catch (err) {
      setNote({ ok: false, text: plain(err) })
    } finally {
      if (!started) setPlaying(null)
    }
  }

  const choose = async (entry: GalleryVoice): Promise<void> => {
    setNote(null)
    try {
      const id = entry.provider === 'elevenlabs' ? await elevenId(entry) : undefined
      await patch(galleryPatch(settings, entry, id))
      if (entry.provider === 'piper') {
        setNote({ ok: true, text: `${entry.label} wird geholt, falls sie noch fehlt. Das kann einen Moment dauern.` })
        await window.jarvis.invoke('local:install', { id: 'piper-voice', choice: entry.voice })
      }
      const key = NEEDS[entry.provider]
      setNote(key && !present(key)
        ? { ok: false, text: `${entry.label} ist gewählt. Es fehlt noch der ${GALLERY_PROVIDER_LABELS[entry.provider].needs} — unten eintragen, bis dahin spricht James mit seiner Rückfallstimme.` }
        : { ok: true, text: `${entry.label} ist jetzt James' Stimme. Im Hauptfenster einfach losreden.` })
    } catch (err) {
      setNote({ ok: false, text: plain(err) })
    }
  }

  return (
    <section className="voice-gallery" aria-label="Stimmen-Galerie">
      <p className="hint">
        Klare Assistentenstimmen nach dem Vorbild von Siri: sauber, ruhig, deutlich. Siris eigene
        Stimme gibt es nur auf Apple-Geräten; die mit „Wie Siri“ markierten kommen ihr am nächsten.
        Anhören kostet nichts oder nur wenige Credits.
      </p>
      <div className="voice-gallery-grid">
        {VOICE_GALLERY.map((entry) => {
          const key = NEEDS[entry.provider]
          const missing = key ? !present(key) : false
          const isActive = active?.id === entry.id
          return (
            <article key={entry.id} className="voice-card" data-active={isActive} aria-label={`Stimme ${entry.label}`}>
              <header>
                <strong>{entry.label}</strong>
                {entry.siriLike && <span className="voice-tag">Wie Siri</span>}
              </header>
              <p>{entry.sound}</p>
              <small>
                {GALLERY_PROVIDER_LABELS[entry.provider].name} · {entry.pitch}
                {missing ? ` · braucht ${GALLERY_PROVIDER_LABELS[entry.provider].needs}` : ''}
              </small>
              <div className="voice-card-actions">
                <button type="button" className="ghost" disabled={playing !== null || missing} onClick={() => void listen(entry)}
                  aria-label={`${entry.label} anhören`}>
                  {playing === entry.id ? 'spricht…' : 'Anhören'}
                </button>
                <button type="button" className={isActive ? 'primary' : ''} aria-pressed={isActive} onClick={() => void choose(entry)}
                  aria-label={isActive ? `${entry.label} ist aktiv` : `${entry.label} wählen`}>
                  {isActive ? 'Aktiv' : 'Wählen'}
                </button>
              </div>
            </article>
          )
        })}
      </div>
      {note && <p className={note.ok ? 'hint' : 'hint warn'} role="status">{note.text}</p>}
    </section>
  )
}

/** Electron setzt „Error invoking remote method …“ vor jede Meldung aus dem Hauptprozess. */
function plain(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
