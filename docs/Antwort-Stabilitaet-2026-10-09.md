# James-Jarvis 1.3.2 – Antwort-Stabilität

Anlass: James antwortete gelegentlich weder auf Sprache noch auf Texteingaben.
Der vorhandene Arbeitsbaum wurde erhalten. Die folgenden Fehler wurden im
Antwortablauf nachgewiesen und mit Regressionstests abgesichert.

## Behobene Ursachen

- Abgebrochene Live-Verbindungen ließen Mikrofon-Sperren und Werkzeugzähler
  stehen. Auch der automatische Wechsel zu einem neuen Gemini-Socket konnte
  einen alten Werkzeugzähler dauerhaft behalten.
- Ein bereits gestoppter Aufbau konnte später Audioressourcen öffnen oder eine
  neuere Sitzung überschreiben. Gleichzeitige Starts teilen nun ihren Aufbau;
  Stoppen, Pause und Sitzungswechsel entziehen alten Vorgängen ihre Zuständigkeit.
- Manche IPC-, Modell- und Stream-Aufrufe warteten trotz Abbruch weiter.
  Aufbau und Antwortvorgänge sind begrenzt und lassen sich sofort abbrechen.
- Bei Ollama endete das Zeitlimit mit dem Empfang der HTTP-Kopfzeilen. Ein
  blockierter Antwortinhalt konnte danach unbefristet hängen.
- Ein fehlendes Abschlussereignis der lokalen Stimme hielt das Mikrofon gesperrt.
  Eine begrenzte Wartezeit gibt es nun frei; laufende Audiowiedergabe wird berücksichtigt.
- Ein langsamer Mikrofonstart verhinderte die Registrierung der Texteingabe.
  Die Eingabe wird früh verdrahtet und benötigt keine fertige Mikrofonfreigabe.
- Schnelle Pause/Wiederaufnahme konnte eine neue Sitzung durch den verspäteten
  Abschluss der alten Pause stoppen. Veraltete Zustandsmeldungen werden verworfen.
- Texteingaben wurden auch bei einem fehlgeschlagenen Transport als gesendet
  bestätigt. Die Motoren melden den tatsächlichen Sendestatus; der Entwurf bleibt erhalten.

## Prüfung

- TypeScript-Prüfung bestanden.
- Vollständige Testsuite: **1.857 bestanden**, keine Fehler, keine übersprungenen Tests.
  Insgesamt 58 Regressionstests ergänzt; vorhandene VM-Fixtures um Timer,
  Abbruchsignale und Alias-Auflösung ergänzt.
- Produktionsbuild bestanden.
- Electron-Oberflächentest mit isoliertem Profil bestanden: fehlgeschlagene
  Texteingabe wird wiederhergestellt, Fehler angezeigt, Oberfläche bleibt bedienbar.
  Einstellungen, Diagnose und simulierte Fehlerberichte ebenfalls geprüft.
- Karten-Oberflächentest bestanden: Vektorkacheln, Orte, Routen, Quellen,
  Termine, Verschieben/Zoomen, Ausblenden, Linkprüfung; keine Rendererfehler.
- Diff-Prüfung ohne Formatfehler bestanden.
- Profilsicherung erstellt; Datenbank über `VACUUM INTO` konsistent kopiert und
  mit `PRAGMA quick_check` geprüft. Einstellungen und verschlüsselte Zugänge bleiben lokal.

Protokolle liegen unter `out/audit/reliability-1.3.2-*.log`. Diese Dateien
werden nicht in den Installer aufgenommen. Paket- und Installationsstatus
stehen im aktuellen Abschnitt von `UPDATE.md`.

## Verbleibende Grenzen

Die Fehlerfälle wurden mit simulierten Verbindungen und Audioressourcen getestet;
der Ollama-Hänger zusätzlich mit einem echten lokalen HTTP-Server. Echte
Mikrofonerkennung und persönliche Kontoantworten sind nicht vollständig geprüft.
Der separate Zugangscheck konnte die verschlüsselten Profile nicht lesen; das
belegt keinen fehlenden Zugang in der installierten App.

Die Live-Wache greift bei Texteingaben, nach erkannten gesprochenen Beiträgen und
nach Werkzeugergebnissen. Wenn ein Server Audio annimmt, aber überhaupt keine
Spracherkennung oder Ereignisse liefert, lässt sich das damit allein nicht erkennen.
Nach einem Antwortfehler werden Anfragen nicht automatisch erneut ausgeführt,
damit bereits erfolgte Werkzeugaktionen nicht doppelt stattfinden.
