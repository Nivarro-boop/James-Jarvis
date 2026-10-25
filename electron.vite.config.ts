import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Minifiziert wird überall, und zwar mit erhaltenen Namen.
 *
 * electron-vite baut ohne diese Angabe alles unminifiziert — im Hauptprozess
 * waren das 2,07 MB Quelltext samt Kommentaren, die V8 bei jedem Start
 * durchparsen muss, im Kristallfenster 2,38 MB. Beides ist reine Wartezeit
 * vor dem ersten Bild, und beides landet unverändert im Installer.
 *
 * `keepNames` kostet ein paar Kilobyte und erhält dafür Funktions- und
 * Klassennamen im Stapelspeicher. Das ist hier keine Bequemlichkeit: Die
 * Selbstheilung schreibt Fehler mit, und ein Protokolleintrag aus `t.p1()`
 * beantwortet keine einzige Frage.
 */
const minified = {
  minify: 'esbuild' as const,
  // Fehlermeldungen sollen lesbar bleiben, siehe oben.
  esbuildOptions: { keepNames: true }
}

/**
 * Der mitgelieferte Google-Client (siehe src/main/providers/googleBuiltin.ts).
 *
 * Kommt aus der Umgebung — in der Release-Action aus den GitHub-Secrets — oder
 * aus einer lokalen `.env.google` mit Zeilen `NAME=wert`. Die Datei ist über
 * `.env.*` in .gitignore ausgeschlossen. Fehlt beides, baut der Build ohne
 * eingebauten Zugang, und die Einstellungen fragen wie bisher nach einem
 * eigenen Client.
 */
function googleClientEnv(): Record<string, string> {
  const values: Record<string, string> = {}
  const file = resolve('.env.google')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(JARVIS_GOOGLE_CLIENT_(?:ID|SECRET))\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line)
      if (match) values[match[1]] = match[2].trim()
    }
  }
  for (const name of ['JARVIS_GOOGLE_CLIENT_ID', 'JARVIS_GOOGLE_CLIENT_SECRET']) {
    const value = process.env[name]?.trim()
    if (value) values[name] = value
  }
  return values
}

const googleEnv = googleClientEnv()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __JARVIS_GOOGLE_CLIENT_ID__: JSON.stringify(googleEnv.JARVIS_GOOGLE_CLIENT_ID ?? ''),
      __JARVIS_GOOGLE_CLIENT_SECRET__: JSON.stringify(googleEnv.JARVIS_GOOGLE_CLIENT_SECRET ?? '')
    },
    build: {
      minify: minified.minify,
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    },
    esbuild: minified.esbuildOptions,
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: minified.minify,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    },
    esbuild: minified.esbuildOptions,
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      minify: minified.minify,
      rollupOptions: {
        input: {
          crystal: resolve('src/renderer/crystal.html'),
          settings: resolve('src/renderer/settings.html')
        }
      }
    },
    esbuild: minified.esbuildOptions,
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer')
      }
    },
    plugins: [react()],
    // AudioWorklets werden als rohe Assets ausgeliefert, nicht gebundelt —
    // sie laufen in einem eigenen Realm ohne Modul-Auflösung.
    assetsInclude: ['**/*.onnx']
  }
})
