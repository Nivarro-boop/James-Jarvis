import { useEffect, useRef, useState, type JSX } from 'react'
import type { BrainGraph, Widget } from '@shared/brain'
import './brain.css'

/**
 * Die Gehirn-Karte: Notizen und Projekte als Punkte auf einer Kugel, Linien
 * für [[Verweise]] und gemeinsame #Schlagworte.
 *
 * Gezeichnet auf einem 2D-Canvas mit eigener Perspektive statt mit einer
 * 3D-Bibliothek — ein paar hundert Punkte brauchen kein WebGL, und die App
 * bleibt so klein, wie sie ist.
 */

interface Point { x: number; y: number; z: number }

/** Gleichmäßig auf der Kugel verteilt (Fibonacci-Gitter). */
function spherePoints(n: number): Point[] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  return Array.from({ length: n }, (_, i) => {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    return { x: Math.cos(golden * i) * r, y, z: Math.sin(golden * i) * r }
  })
}

/**
 * Handsteuerung ohne Bibliothek: Bewegung zwischen zwei Kamerabildern,
 * davon der waagrechte Schwerpunkt. Wandert er nach links oder rechts,
 * dreht sich die Karte mit. Bild verlässt den Rechner nicht.
 */
function useHandSwipe(enabled: boolean, onSwipe: (dx: number) => void): string {
  const [status, setStatus] = useState('')
  const swipe = useRef(onSwipe)
  swipe.current = onSwipe
  useEffect(() => {
    if (!enabled) { setStatus(''); return }
    let stream: MediaStream | null = null
    let timer = 0
    let stopped = false
    const video = document.createElement('video')
    const canvas = document.createElement('canvas')
    canvas.width = 64; canvas.height = 48
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    let previous: Uint8ClampedArray | null = null
    let lastX: number | null = null
    void navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } }).then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return }
      stream = s
      video.srcObject = s
      void video.play()
      setStatus('Kamera an — Hand links oder rechts bewegen.')
      timer = window.setInterval(() => {
        if (!ctx || video.readyState < 2) return
        ctx.drawImage(video, 0, 0, 64, 48)
        const frame = ctx.getImageData(0, 0, 64, 48).data
        if (previous) {
          let sum = 0; let weight = 0
          for (let i = 0; i < frame.length; i += 4) {
            const d = Math.abs(frame[i] - previous[i]) + Math.abs(frame[i + 1] - previous[i + 1]) + Math.abs(frame[i + 2] - previous[i + 2])
            if (d > 90) { sum += (i / 4) % 64; weight++ }
          }
          if (weight > 40) {
            // Gespiegelt: Die Kamera sieht die Hand seitenverkehrt.
            const x = 1 - sum / weight / 64
            if (lastX !== null) swipe.current((x - lastX) * 4)
            lastX = x
          } else lastX = null
        }
        previous = frame
      }, 80)
    }).catch(() => setStatus('Keine Kamera verfügbar.'))
    return () => {
      stopped = true
      window.clearInterval(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [enabled])
  return status
}

export function BrainMap({ onClose }: { onClose: () => void }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [graph, setGraph] = useState<BrainGraph | null>(null)
  const [selected, setSelected] = useState<{ label: string; text: string } | null>(null)
  const [hand, setHand] = useState(false)
  const rotation = useRef({ yaw: 0, pitch: 0.3, spin: 0.002 })
  const projected = useRef<{ id: string; label: string; x: number; y: number; r: number }[]>([])
  const handStatus = useHandSwipe(hand, (dx) => { rotation.current.spin = 0; rotation.current.yaw += dx })

  useEffect(() => { void window.jarvis.invoke('brain:graph').then(setGraph) }, [])

  useEffect(() => {
    const el = canvas.current
    if (!el || !graph) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const points = spherePoints(graph.nodes.length)
    const index = new Map(graph.nodes.map((n, i) => [n.id, i]))
    const style = getComputedStyle(el)
    const color = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
    let frame = 0
    const draw = (): void => {
      const { width, height } = el.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      if (el.width !== Math.round(width * dpr)) { el.width = Math.round(width * dpr); el.height = Math.round(height * dpr) }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const rot = rotation.current
      rot.yaw += rot.spin
      const radius = Math.min(width, height) * 0.38
      const [cy, sy, cp, sp] = [Math.cos(rot.yaw), Math.sin(rot.yaw), Math.cos(rot.pitch), Math.sin(rot.pitch)]
      const screen = points.map((p) => {
        const x = p.x * cy - p.z * sy
        const z1 = p.x * sy + p.z * cy
        const y = p.y * cp - z1 * sp
        const z = p.y * sp + z1 * cp
        const scale = 2.4 / (3 - z)
        return { x: width / 2 + x * radius * scale, y: height / 2 + y * radius * scale, z, scale }
      })
      ctx.strokeStyle = color('--brain-link', 'rgba(120,160,255,0.25)')
      ctx.lineWidth = 1
      for (const link of graph.links) {
        const a = screen[index.get(link.source) ?? -1]; const b = screen[index.get(link.target) ?? -1]
        if (!a || !b) continue
        ctx.globalAlpha = 0.25 + 0.35 * ((a.z + b.z) / 4 + 0.5)
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      }
      const order = screen.map((s, i) => ({ s, i })).sort((a, b) => a.s.z - b.s.z)
      projected.current = []
      for (const { s, i } of order) {
        const node = graph.nodes[i]
        const r = (node.kind === 'projekt' ? 6 : 4) * s.scale
        ctx.globalAlpha = 0.35 + 0.65 * (s.z / 2 + 0.5)
        ctx.fillStyle = node.kind === 'projekt' ? color('--brain-project', '#f5b94a') : color('--brain-note', '#7aa7ff')
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill()
        if (s.z > 0.3) {
          ctx.fillStyle = color('--brain-label', '#cfd8ea')
          ctx.font = '11px system-ui, sans-serif'
          ctx.fillText(node.label.slice(0, 28), s.x + r + 3, s.y + 4)
        }
        projected.current.push({ id: node.id, label: node.label, x: s.x, y: s.y, r: r + 4 })
      }
      ctx.globalAlpha = 1
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [graph])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    let drag: { x: number; y: number } | null = null
    const down = (e: PointerEvent): void => { drag = { x: e.clientX, y: e.clientY }; rotation.current.spin = 0 }
    const move = (e: PointerEvent): void => {
      if (!drag) return
      rotation.current.yaw += (e.clientX - drag.x) * 0.008
      rotation.current.pitch = Math.max(-1.3, Math.min(1.3, rotation.current.pitch + (e.clientY - drag.y) * 0.008))
      drag = { x: e.clientX, y: e.clientY }
    }
    const up = (e: PointerEvent): void => {
      const moved = drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3
      drag = null
      if (moved) return
      const box = el.getBoundingClientRect()
      const x = e.clientX - box.left; const y = e.clientY - box.top
      const hit = [...projected.current].reverse().find((p) => Math.hypot(p.x - x, p.y - y) <= p.r)
      if (hit) void window.jarvis.invoke('brain:note', { file: hit.id }).then((text) => setSelected({ label: hit.label, text: text ?? 'Nicht lesbar.' }))
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { el.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [])

  return (
    <div className="brain-overlay" role="dialog" aria-label="Gehirn-Karte">
      <div className="brain-head">
        <strong>Gehirn</strong>
        <span className="brain-count">{graph ? `${graph.nodes.length} Einträge · ${graph.links.length} Verbindungen` : 'Lädt …'}</span>
        <label className="brain-hand">
          <input type="checkbox" checked={hand} onChange={(e) => setHand(e.target.checked)} /> Handsteuerung
        </label>
        <button type="button" onClick={onClose}>Schließen</button>
      </div>
      {handStatus && <div className="brain-status">{handStatus}</div>}
      {graph && graph.nodes.length === 0 && (
        <div className="brain-empty">Noch leer. Sag „leg ein Projekt an“ oder „speicher eine Notiz“.</div>
      )}
      <canvas ref={canvas} className="brain-canvas" />
      {selected && (
        <aside className="brain-note">
          <div className="brain-note-head"><strong>{selected.label}</strong><button type="button" onClick={() => setSelected(null)}>×</button></div>
          <pre>{selected.text}</pre>
        </aside>
      )}
    </div>
  )
}

/** Kacheln, die James auf Zuruf baut (`widget_set`). */
export function WidgetTiles(): JSX.Element | null {
  const [widgets, setWidgets] = useState<Widget[]>([])
  useEffect(() => {
    return window.jarvis.on('brain:widgets', setWidgets)
  }, [])
  if (!widgets.length) return null
  return (
    <div className="widget-tiles">
      {widgets.map((w) => (
        <section key={w.id} className="widget-tile">
          <header>
            <span>{w.title}</span>
            <button type="button" aria-label={`${w.title} entfernen`} onClick={() => { void window.jarvis.invoke('brain:removeWidget', { id: w.id }) }}>×</button>
          </header>
          <strong>{w.value}</strong>
          {w.items?.length ? <ul>{w.items.map((item, i) => <li key={i}>{item}</li>)}</ul> : null}
        </section>
      ))}
    </div>
  )
}
