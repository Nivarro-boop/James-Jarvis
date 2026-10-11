// Nur zum Prüfen des Kristall-Renderings ohne Electron.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer') }
  },
  plugins: [react()],
  server: { port: 5199 }
})
