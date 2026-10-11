# James-Jarvis – Projektübergabe

Lies zuerst `UPDATE.md` in dieser Projektwurzel. Dort stehen der aktuelle
Update-Stand, Prüfungen, Installer und verbleibende Grenzen.

Windows/Electron-Projekt mit TypeScript und React. Einstieg: `README.md`.
Hauptprozess: `src/main`; Oberfläche: `src/renderer`; gemeinsame Verträge:
`src/shared`; Tests: `tests`.

Prüfen: `npm run typecheck`, `npm test -- --low-resource`.
Bauen: `npm run dist`. Ergebnis: `dist/James-Jarvis Setup <Version>.exe`.
Karten-Oberfläche nach dem Build: `node scripts/check-maps-ui.cjs`.

Der Arbeitsbaum enthält umfangreiche vorhandene, nicht eingecheckte Änderungen.
Diese erhalten; keine pauschalen Resets oder Überschreibungen durchführen.
Keine persönlichen Profile, Tokens oder Schlüssel in Berichte übernehmen.
Ein erfolgreiches Build ersetzt keine echten Mikrofon- oder Konto-Prüfungen.
