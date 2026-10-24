# iPhone, Sprache und Update 1.3.10 – 24.10.2026

Die iPhone-Oberfläche wird vom Rechner ausgeliefert. Die Änderungen gelten damit
für Safari, die Home-Bildschirm-Version und die bestehende native WebView-Hülle.

## Behobene Fehler

- Die Audioausgabe hält während einer gesperrten oder unterbrochenen Ausgabe bis
  zu acht Sekunden PCM bereit. Nach Freigabe spielt sie die Blöcke in Reihenfolge
  ab. Unterbrechen und Seitenwechsel löschen alte Ausgabe.
- Ein optional unterstütztes `navigator.audioSession` schaltet nach Ende der
  Aufnahme zurück auf `playback`. Mikrofonspuren und Aufnahme-Kontext werden
  freigegeben; die Aufnahmebetriebsart bleibt nicht versehentlich aktiv.
- Loslassen während der Mikrofonfreigabe startet keine nachträgliche Aufnahme.
  Abbruch, Fokusverlust und Pointer-Verlust beenden das Sprechen. Der Controller
  schützt zusätzlich vor verspätetem Öffnen nach einer Pause.
- Handy-Texte verwenden `sendTyped` statt des Wegs für automatische Hinweise.
  Dadurch können sie James aus der Pause holen und fehlgeschlagenes Senden wird
  zurückgemeldet. Entwürfe bleiben bis zur Bestätigung und nach Fehlern erhalten.
  Nach 30 Sekunden ohne Bestätigung wird kein automatisches Duplikat gesendet.
- Der Server meldet, ob das James-Fenster verfügbar ist. Ungültige Telefonbefehle,
  nichtboolesche Mikrofonwerte, überlange Texte und kaputte PCM-Rahmen werden
  abgewiesen. Ein abgelöster Renderer kann keine alte Ausgabe mehr weiterreichen.
- Der Service Worker aktualisiert ausschließlich eigene Hüllendateien, speichert
  nur erfolgreiche Antworten und gibt bei fehlenden Skripten kein HTML zurück.
- Das Windows-Paket nimmt nur die drei gebauten Laufzeitordner auf. Temporäre
  Prüfprogramme können dadurch weder versehentlich ausgeliefert werden noch
  durch ihr Löschen während einer UI-Prüfung den Paketbau abbrechen.

## Oberfläche

Neue Kopplungsansicht, lesbarer Status, Audiofreigabe mit lokalem Testton,
Gespräch mit bis zu 30 Beiträgen, mehrzeilige Eingabe mit gespeichertem Entwurf,
Verbindungsreparatur und zugängliche Sprechbedienung. Zoom ist wieder erlaubt.
Bei gefülltem Verlauf macht die dekorative Kugel Platz für die Bedienung.

[Handy-Ansicht](screenshots/phone-2026-10-24/main.png) ·
[Koppeln](screenshots/phone-2026-10-24/pairing.png) ·
[Kleines Display](screenshots/phone-2026-10-24/small.png)

## Prüfung

- Desktop- und Mobile-Typecheck bestanden; zusätzlich vier Mobile-Kopplungstests
  und elf Tests des Fehlerbericht-Backends bestanden (insgesamt **2.116 Tests**).
- Gesamtsuite: **2.101 Tests bestanden**, keine Fehler oder übersprungenen Tests.
- Neue Regressionstests: Audiofreigabe, begrenzter Audiopuffer, verspätete
  Mikrofonfreigabe, Entwürfe und Sendebestätigung, Controller-Abbruch sowie echte
  Telefon-/Renderer-WebSockets mit PCM-Weiterleitung und Rechnerausfall.
- `node scripts/check-phone-ui.cjs`: 390 × 844 und 320 × 568, keine seitlichen
  Überläufe, keine JavaScript-Fehler, tatsächlicher Browser-Audiokontext aktiv,
  Testton geplant, Texte bestätigt und nicht verfügbarer Rechner angezeigt.
- Alle sieben vorhandenen Desktop-UI-Prüfungen bestanden: redesign, ui,
  workspace, context, maps, connectors, learning. Isolierte Profile; dort keine
  echten Kontoanfragen oder Diagnoseübertragungen.

## Anwendung am iPhone

Die lokale Handy-Verbindung war bei der Untersuchung ausgeschaltet. Vor der
Aktivierung und Installation wurde eine Profilsicherung mit konsistenter,
geprüfter SQLite-Kopie erstellt. Die Verbindung wurde eingeschaltet. Version **1.3.10** wurde am bisherigen Ort
installiert und gestartet (Installer-Rückgabewert 0). Alle vier geprüften
installierten Handy-Ressourcen stimmen mit den Quellen überein. Die neue Seite
wird vom installierten Prozess über HTTPS auf Port 8788 ausgeliefert.

James am PC öffnen. Auf dem iPhone die James-Seite neu öffnen und **Ton prüfen**
antippen. Anschließend eine Nachricht senden oder die Sprechtaste halten.
Wenn die Kopplung noch fehlt: am PC **Einstellungen → Telefon**, die dort
angezeigten Schritte und QR-Codes verwenden. Das Zertifikat ist am iPhone
gegebenenfalls unter **Allgemein → Info → Zertifikatsvertrauenseinstellungen**
zu bestätigen; das kann der Rechner nicht aus der Ferne erledigen.

Die Zertifikatsbestätigung am iPhone ist laut gespeicherter Einrichtung noch
offen (`caInstalled: false`); vorhandene Zertifikatsdateien wurden erhalten.

Die hörbare Ausgabe auf einem echten iPhone, Bluetooth-Routing, das native
Swift-Modul und ein neuer iOS-Build sind hier nicht geprüft. Die Änderungen an
der ausgelieferten Seite benötigen keinen neuen iOS-Build. Es wurde nichts
committet, gepusht oder öffentlich veröffentlicht.

Technische Referenzen zum Audioweg:
[Browser-Autoplay](https://developer.chrome.com/blog/autoplay) und
[AudioSession-Typen](https://developer.mozilla.org/en-US/docs/Web/API/AudioSession/type).
`audioSession` wird nur bei vorhandener Browserunterstützung verwendet.
