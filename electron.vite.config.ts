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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
