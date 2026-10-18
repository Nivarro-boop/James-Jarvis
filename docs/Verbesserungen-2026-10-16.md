# James-Jarvis – lokale Verbesserungen vom 16.10.2026

Die vorhandene Electron-App wurde überarbeitet. Die Paketversion bleibt 1.3.7;
dieser Stand ist lokal gebaut, ohne neuen Installer und ohne Veröffentlichung.

## Bedienung und Darstellung

- Ruhige grüne Startseite mit lokal geladener Manrope-Schrift, sichtbarem
  Sprachzustand und kompaktem Kopfbereich, sobald Gespräch oder Ergebnisse Platz brauchen.
- Mehrzeilige Texteingabe: Enter sendet, Shift+Enter erzeugt eine neue Zeile,
  Strg+L fokussiert die Eingabe. IME-Bestätigungen und wiederholte Enter-Ereignisse
  senden keinen zusätzlichen Auftrag. Der Entwurf bleibt bis zur Annahme erhalten;
  ein bereits geänderter Entwurf wird nach erfolgreichem Senden nicht geleert.
- Der Gesprächsverlauf zeigt Status, Uhrzeiten und Kopieren mit Rückmeldung.
  Beim Lesen älterer Beiträge bleibt die Position auch während neuer Antworten
  erhalten. Ein Knopf führt zu den neuesten Nachrichten zurück.
- Einstellungen über alle Bereiche und passende Suchbegriffe auffindbar,
  einschließlich erweiterter Bereiche. Strg+K öffnet die Suche; Enter, Pfeil nach
  unten und Escape bedienen sie. Navigation setzt Scrollposition und Fokus
  zurück. Ladefehler bieten einen erneuten Versuch; Speicherzustände sind sichtbar.
- Fertige Recherchen erscheinen wieder als Ergebniskarte. Timer verschwinden
  nach erfolgreichem Stoppen sofort; Fehler beim Stoppen werden angezeigt.
- Die Live-Anzeige bevorzugt den neuesten laufenden Arbeitsschritt und zeigt den
  tatsächlich verwendeten Sprachmotor, sobald dieser bekannt ist. Unnötige
  sekündliche Aktualisierungen der gesamten Startseite entfallen.

## Stabilität

- Parallele Office-Speicherungen erhalten eigene Namen durch exklusives Anlegen.
  Auch nach 99 belegten Namen kann die Ausweichdatei keine andere Ausgabe überschreiben.
- Neue Textdateien werden exklusiv angelegt. Ausdrückliches Überschreiben und
  Anhängen bleiben möglich.
- Einzelner Abbruch und Not-Aus geben James auch bei einem Dienst frei, der sein
  Abbruchsignal ignoriert. Verspätete Ergebnisse, Sprache, Karten und
  Statusmeldungen dieses Werkzeugaufrufs werden verworfen. Der zugrunde liegende
  Dienst lässt sich damit nicht zwangsweise beenden; bereits ausgeführte Aktionen
  werden nicht rückgängig gemacht.

## Prüfung

- `npm run typecheck`: bestanden.
- `npm test -- --low-resource`: **2.029 Tests bestanden**, keine ausgelassenen Tests.
- `npm run build`: bestanden. Vite meldet weiterhin große Renderer-Bündel und
  bereits gemischt statisch/dynamisch eingebundene Module.
- `node scripts/check-workspace-ui.cjs`: gebaute Electron-App mit isoliertem
  temporären Profil; mehrzeilige Eingabe, IME, doppelte Eingaben, fehlgeschlagener
  Versand, neue Entwürfe, Tastaturkürzel, Fertigkeiten, Aktionslog, Stoppen,
  fertige Recherche und Einstellungssuche geprüft. Fenstergrößen 520×480,
  900×640 und 1400×900; keine Rendererfehler.
- `node scripts/check-conversation-ui.cjs`: isolierter Chromium-Test für
  Streaming, Leseposition, gekürzten Verlauf, Sprung zur neuesten Nachricht und
  erfolgreiche/abgelehnte Zwischenablagezugriffe.
- Einstellungen zusätzlich mit simulierten Speicher- und Ladefehlern geprüft:
  Wartestatus, Erfolg, Fehler, erneuter Versuch sowie schmale Darstellung.
- Neue Regressionstests prüfen echte konkurrierende Dateischreibzugriffe und
  nicht kooperative Werkzeuge nach Abbruch. Der CSS-Vertrag berücksichtigt jetzt
  tatsächlich importierte Komponenten-Stylesheets und deren lokale `@import`-Dateien.

Screenshots liegen unter `out/audit/workspace-*.png`. Die Prüfungen verwenden
Testdaten und simulierte Texteingaben; echte Konten, Spracherkennung und
Mikrofonhardware wurden in diesem Durchgang nicht geprüft.
