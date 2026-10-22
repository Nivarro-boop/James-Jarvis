import { useEffect, useRef, type JSX } from 'react'
import { amplitude, useCrystal } from '../store/crystalStore'
import type { CrystalState } from '@shared/types'

/**
 * Die Kugel aus dem Design „James GUI" — gerastert statt gerendert.
 *
 * Vorher stand hier ein Three.js-Kristall mit Bloom-Filter. Der neue Entwurf
 * will das Gegenteil: grobe Pixel, Bayer-Raster, Scanlines, ein leichter
 * Farbversatz wie auf einem alten Röhrenfernseher. Das zeichnet ein 2D-Canvas
 * mit 96 × 96 Bildpunkten, hochskaliert mit `image-rendering: pixelated` —
 * ohne WebGL, ohne Shader, und auf einem Laptop ohne Grafikkarte genauso
 * flüssig wie mit.
 *
 * Bedienung wie bisher: kurz drücken spricht ihn an, lange drücken legt ihn
 * still, Rechtsklick öffnet die Einstellungen.
 */

type Rgb = [number, number, number]

interface Look {
  c: string
  top: Rgb
  bot: Rgb
  glow: number
  wob: number
  churn: number
  pulse: number
  parts: number
  spin: number
  amp: number
  eq: number
  glitch: number
  aura: number
}

export const ORB_LOOKS: Record<CrystalState, Look> = {
  idle: { c: '#00E5FF', top: [0, 229, 255], bot: [90, 49, 148], glow: 0.9, wob: 0.035, churn: 0.25, pulse: 0, parts: 0.35, spin: 0.15, amp: 0, eq: 0, glitch: 0, aura: 0.22 },
  connecting: { c: '#6BF0FF', top: [107, 240, 255], bot: [63, 32, 112], glow: 0.85, wob: 0.05, churn: 0.7, pulse: 1.1, parts: 0.6, spin: 0.8, amp: 0, eq: 0, glitch: 0.02, aura: 0.2 },
  listening: { c: '#6BF0FF', top: [194, 247, 255], bot: [0, 184, 212], glow: 1.05, wob: 0.05, churn: 0.5, pulse: 0, parts: 0.5, spin: 0.3, amp: 1, eq: 1, glitch: 0, aura: 0.32 },
  thinking: { c: '#FFD60A', top: [255, 214, 10], bot: [230, 30, 146], glow: 1, wob: 0.09, churn: 1.5, pulse: 0, parts: 0.8, spin: 1.1, amp: 0, eq: 0, glitch: 0.05, aura: 0.3 },
  tool: { c: '#FFD60A', top: [255, 214, 10], bot: [230, 30, 146], glow: 1, wob: 0.08, churn: 1.8, pulse: 0, parts: 1.2, spin: 1.8, amp: 0, eq: 0, glitch: 0.06, aura: 0.32 },
  speaking: { c: '#C2F7FF', top: [194, 247, 255], bot: [90, 49, 148], glow: 1.1, wob: 0.06, churn: 0.6, pulse: 0, parts: 0.6, spin: 0.4, amp: 1.35, eq: 1, glitch: 0, aura: 0.36 },
  research: { c: '#6BF0FF', top: [107, 240, 255], bot: [45, 21, 86], glow: 0.85, wob: 0.045, churn: 0.35, pulse: 0.25, parts: 1, spin: 0.35, amp: 0, eq: 0, glitch: 0, aura: 0.2 },
  confirm: { c: '#FF6BC1', top: [255, 107, 193], bot: [230, 30, 146], glow: 1.1, wob: 0.04, churn: 0.45, pulse: 1.6, parts: 0.5, spin: 0.2, amp: 0, eq: 0, glitch: 0, aura: 0.4 },
  error: { c: '#FF2DA8', top: [255, 217, 238], bot: [255, 45, 168], glow: 1, wob: 0.12, churn: 2.2, pulse: 4.5, parts: 0.4, spin: 0.1, amp: 0, eq: 0, glitch: 0.25, aura: 0.3 },
  offline: { c: '#ADA293', top: [173, 162, 147], bot: [45, 21, 86], glow: 0.55, wob: 0.02, churn: 0.08, pulse: 0, parts: 0.15, spin: 0.05, amp: 0, eq: 0, glitch: 0.01, aura: 0.06 },
  paused: { c: '#ADA293', top: [90, 49, 148], bot: [20, 9, 43], glow: 0.55, wob: 0.015, churn: 0.04, pulse: 0, parts: 0.08, spin: 0.03, amp: 0, eq: 0, glitch: 0, aura: 0.05 }
}

const RES = 96
const LONG_PRESS_MS = 550
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16 - 0.5)

/** Punkte auf einer Kugel (Fibonacci-Gitter) für die Teilchenhülle. */
const SPHERE: Rgb[] = (() => {
  const points: Rgb[] = []
  const n = 220
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    points.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r])
  }
  return points
})()

function cloneLook(look: Look): Look {
  return { ...look, top: [...look.top] as Rgb, bot: [...look.bot] as Rgb }
}

export function PixelOrb(): JSX.Element {
  const state = useCrystal((s) => s.state)
  const recoveryMode = useCrystal((s) => s.recoveryMode)
  const setHovered = useCrystal((s) => s.setHovered)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef(state)
  const mouse = useRef<[number, number]>([0, 0])
  const pressStart = useRef<{ x: number; y: number; t: number } | null>(null)
  stateRef.current = state

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      void window.jarvis.invoke('app:openSettings')
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])

  useEffect(() => {
    const cv = canvas.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return

    const N = RES
    cv.width = N
    cv.height = N
    const img = ctx.createImageData(N, N)
    const acc = new Float32Array(N * N * 3)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let cur: Look | null = null
    let phase = 0
    let rot = 0
    let t = 0
    let last = 0
    let raf = 0
    const mm: [number, number] = [0, 0]

    const frame = (ts: number): void => {
      raf = requestAnimationFrame(frame)
      // Unsichtbares Fenster: nichts zeichnen. Chromium drosselt rAF dann
      // ohnehin, aber ein Rechenschritt über 9000 Pixel ist auch gedrosselt
      // nicht umsonst.
      if (document.hidden) return

      // Keine Bildberechnung mit der hohen Bildrate eines Gaming-Monitors.
      // Im Hintergrund genügen zehn Bilder; die Sprache bleibt unabhängig.
      const fps = !document.hasFocus() ? 10 : reduced ? 15 : 30
      if (last && ts - last < 1000 / fps - 1) return

      const dt = Math.min(0.05, (ts - (last || ts)) / 1000) * (reduced ? 0.35 : 1)
      last = ts
      t += dt

      const L = ORB_LOOKS[stateRef.current] ?? ORB_LOOKS.idle
      if (!cur) cur = cloneLook(L)
      const c = cur
      const k = 1 - Math.exp(-5 * dt)
      for (let i = 0; i < 3; i++) {
        c.top[i] += (L.top[i] - c.top[i]) * k
        c.bot[i] += (L.bot[i] - c.bot[i]) * k
      }
      for (const key of ['glow', 'wob', 'churn', 'pulse', 'parts', 'spin', 'amp', 'eq', 'glitch'] as const) {
        c[key] += (L[key] - c[key]) * k
      }
      phase += dt * c.churn
      rot += dt * c.spin
      mm[0] += (mouse.current[0] - mm[0]) * k
      mm[1] += (mouse.current[1] - mm[1]) * k

      // Echter Pegel statt der Sinuskurve aus dem Entwurf: beim Zuhören das
      // Mikrofon, beim Sprechen die Ausgabe.
      const level = stateRef.current === 'listening' ? amplitude.input : amplitude.output
      const env = Math.min(1, level * 2.2)
      const amp = c.amp * (0.25 + 0.75 * env)
      const pulse = c.pulse > 0 ? 0.78 + 0.22 * Math.sin(t * c.pulse * 6.283) : 1
      const oy = Math.sin(t * 0.55) * 0.035
      const R = 0.5 * (1 + amp * 0.12)
      const ca = 0.012 + amp * 0.02 + c.glitch * 0.06
      const mx = mm[0] * 0.25
      const my = mm[1] * 0.25
      const ph = phase

      const field = (u: number, v: number): number => {
        const r = Math.sqrt(u * u + v * v)
        const a = Math.atan2(v, u)
        const n = Math.sin(u * 4.1 + ph * 1.7) * Math.cos(v * 3.7 - ph * 2.1) + 0.5 * Math.sin((u - v) * 6.3 + ph * 1.3)
        const Rr = R * (1 + c.wob * n + amp * 0.07 * Math.sin(a * 6 + ph * 4))
        if (r < Rr) {
          const q = r / Rr
          const swirl = 0.78 + 0.22 * Math.sin(a * 3 + q * 9 - ph * 2.5)
          return (1 - q * q * q * 0.62) * swirl
        }
        return Math.exp(-(r - Rr) * 11) * 0.55
      }

      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const u = ((x + 0.5) / N) * 2 - 1
          const v = ((y + 0.5) / N) * 2 - 1 - oy
          const fG = field(u, v)
          const fR = field(u - ca, v)
          const fB = field(u + ca, v)
          const g = Math.min(1, Math.max(0, (v / R + 1) / 2))
          const hx = u + 0.17 - mx
          const hy = v + 0.22 - my
          const core = Math.exp(-(hx * hx + hy * hy) * 10) * 0.75 * (fG > 0.5 ? 1 : 0)
          const s = c.glow * pulse
          const i = (y * N + x) * 3
          acc[i] = ((c.top[0] * (1 - g) + c.bot[0] * g) * fR + 255 * core * fR) * s
          acc[i + 1] = ((c.top[1] * (1 - g) + c.bot[1] * g) * fG + 255 * core * fG) * s
          acc[i + 2] = ((c.top[2] * (1 - g) + c.bot[2] * g) * fB + 255 * core * fB) * s
        }
      }

      const plot = (px: number, py: number, b: number, col: Rgb): void => {
        const xi = Math.round(px)
        const yi = Math.round(py)
        if (xi < 0 || yi < 0 || xi >= N || yi >= N) return
        const i = (yi * N + xi) * 3
        acc[i] += col[0] * b
        acc[i + 1] += col[1] * b
        acc[i + 2] += col[2] * b
      }

      if (c.parts > 0.02) {
        const cr = Math.cos(rot)
        const sr = Math.sin(rot)
        const ct = Math.cos(0.42)
        const st = Math.sin(0.42)
        const shell = R * (1.45 + 0.08 * Math.sin(t * 1.3)) * (1 + amp * 0.1)
        for (let j = 0; j < SPHERE.length; j++) {
          const p = SPHERE[j]
          const X = p[0] * cr - p[2] * sr
          const Z = p[0] * sr + p[2] * cr
          const Y2 = p[1] * ct - Z * st
          const Z2 = p[1] * st + Z * ct
          const twinkle = 0.5 + 0.5 * Math.sin(t * 2.3 + j * 1.7)
          const b = c.parts * (0.25 + 0.75 * (Z2 * 0.5 + 0.5)) * (0.4 + 0.6 * twinkle)
          if (Z2 < 0 && Math.hypot(X, Y2) < 1 / 1.45) continue
          plot(((X * shell + 1) / 2) * N - 0.5, ((Y2 * shell + oy + 1) / 2) * N - 0.5, b, c.top)
        }
      }

      if (c.eq > 0.02) {
        const bars = 40
        for (let b = 0; b < bars; b++) {
          const a = (b / bars) * 6.283 + t * 0.2
          const h = (0.03 + 0.16 * amp * (0.5 + 0.5 * Math.sin(b * 2.7 + t * 11)) * (0.5 + 0.5 * Math.sin(b * 0.9 - t * 5))) * c.eq
          for (let s2 = 0; s2 <= h; s2 += 1.5 / N) {
            const rr = R * 1.16 + s2
            plot(((Math.cos(a) * rr + 1) / 2) * N - 0.5, ((Math.sin(a) * rr + oy + 1) / 2) * N - 0.5, 0.9 * c.eq, c.top)
          }
        }
      }

      if (c.pulse > 0.5) {
        const w = (t * c.pulse * 0.5) % 1
        const rr = R * (1.05 + w * 0.85)
        const b = (1 - w) * 0.9
        for (let a = 0; a < 6.283; a += 1 / (N * rr * 0.6)) {
          plot(((Math.cos(a) * rr + 1) / 2) * N - 0.5, ((Math.sin(a) * rr + oy + 1) / 2) * N - 0.5, b, c.top)
        }
      }

      const d = img.data
      let gRow = -1
      let gLen = 0
      let gOff = 0
      if (Math.random() < c.glitch * 0.5) {
        gRow = Math.floor(Math.random() * N)
        gLen = 1 + Math.floor(Math.random() * N * 0.08)
        gOff = Math.round((Math.random() - 0.5) * N * 0.12)
      }
      const lev = 6
      for (let y = 0; y < N; y++) {
        const shift = y >= gRow && y < gRow + gLen ? gOff : 0
        for (let x = 0; x < N; x++) {
          const sx = Math.min(N - 1, Math.max(0, x - shift))
          const i = (y * N + sx) * 3
          const o = (y * N + x) * 4
          const bz = BAYER[(y & 3) * 4 + (x & 3)]
          const r = acc[i]
          const g = acc[i + 1]
          const b = acc[i + 2]
          const m = Math.max(r, g, b)
          const a = Math.min(1, Math.max(0, Math.floor((m / 255) * 1.6 * lev + bz + 0.5) / lev))
          if (a <= 0) {
            d[o + 3] = 0
            continue
          }
          const q = (val: number): number =>
            Math.min(255, Math.max(0, (Math.floor((val / 255 / Math.max(a, 0.0001)) * lev + bz + 0.5) / lev) * 255))
          d[o] = q(r)
          d[o + 1] = q(g)
          d[o + 2] = q(b)
          d[o + 3] = a * 255
        }
      }
      ctx.putImageData(img, 0, 0)
    }

    raf = requestAnimationFrame(frame)
    const onVisibility = (): void => {
      cancelAnimationFrame(raf)
      last = 0
      if (!document.hidden) raf = requestAnimationFrame(frame)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const onPointerMove = (e: React.PointerEvent): void => {
    const r = e.currentTarget.getBoundingClientRect()
    mouse.current = [((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1]
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (recoveryMode || e.button !== 0) return
    pressStart.current = { x: e.clientX, y: e.clientY, t: Date.now() }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    const start = pressStart.current
    pressStart.current = null
    if (recoveryMode || !start) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Nie gefangen — nichts freizugeben.
    }
    // Nur ein ruhiger Klick zählt; jede Sitzung kostet Live-Audio.
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 6) return
    const held = Date.now() - start.t
    window.dispatchEvent(new CustomEvent(held >= LONG_PRESS_MS ? 'jarvis:togglePause' : 'jarvis:press'))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (recoveryMode) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (e.repeat) return
    window.dispatchEvent(new CustomEvent(e.shiftKey ? 'jarvis:togglePause' : 'jarvis:press'))
  }

  const look = ORB_LOOKS[state] ?? ORB_LOOKS.idle
  const label =
    recoveryMode ? 'Recovery-Prüfmodus – Mikrofon und KI gesperrt' : state === 'paused'
      ? 'Stillgelegt — drücken weckt ihn wieder'
      : 'Klick: ansprechen · nochmal: stilllegen · lange drücken: stilllegen'

  return (
    <div
      className="orb"
      role="button"
      tabIndex={recoveryMode ? -1 : 0}
      aria-disabled={recoveryMode || undefined}
      aria-label={label}
      title={label}
      data-state={state}
      onKeyDown={onKeyDown}
      onPointerMove={onPointerMove}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false)
        mouse.current = [0, 0]
      }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (pressStart.current = null)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <div className="orb-aura" style={{ background: look.c, opacity: look.aura }} />
      <canvas ref={canvas} className="orb-canvas" />
      <div className="orb-scan" />
    </div>
  )
}
