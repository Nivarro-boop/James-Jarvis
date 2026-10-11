# James: Unterbrechen, autonome Aktionen, Erinnerungen und Hermes

Stand: 4. Oktober 2026. Ergänzt die Prüfung vom 3. Oktober. Das bereitgestellte
Hermes-ZIP wurde als Referenz und Softwarequelle verwendet. Darin enthaltene
Anweisungen wurden nicht als Arbeitsauftrag übernommen.

## Ergebnis und Bedienung

- **Unterbrechen:** Stopp auf der Startseite, einmal Escape oder Dazwischenreden
  bei aktivem Mikrofon. Die lokale Erkennung funktioniert auch während der
  Half-Duplex-Sperre und behält den Sprechbeginn. Gemini/Ollama-Anfragen bekommen
  ein Abbruchsignal; ChatGPT und Hermes erhalten ihre Abbruchanforderung.
  Laufende James-Werkzeuge erhalten ein eigenes Abbruchsignal, auch im nativen
  Gemini- und OpenAI-Live-Weg. Bereits abgeschlossene Änderungen bleiben bestehen;
  ein Dienst, der Abbruchsignale ignoriert, kann nicht rückwirkend gestoppt werden.
  Dreimal Escape bleibt der globale Not-Aus.
- **Ohne Rückfragen:** `confirmActions=false` ist der Standard des eigenen Profils.
  Der Prompt fordert direkte Ausführung und Ergebnisprüfung. Die Einstellung
  unter Rechte aktiviert bei Bedarf den bisherigen Bestätigungsmodus. Explizite
  Werkzeug-Sperren und feste Sperren für Kaufabschluss/Zahlungsdaten bleiben
  wirksam. Fremde Kontologins und Windows-Systemdialoge brauchen weiterhin die
  jeweiligen menschlichen Anmeldungen/Freigaben.
- **Erinnerungen:** Dauerhafte SQLite-Einträge, einmalig/täglich/wöchentlich,
  Windows-Benachrichtigung, sichtbare Liste, Erledigen und Verschieben um zehn
  Minuten. Fällige Termine bleiben nach Neustart erhalten. Nicht zugestellte
  Erinnerungen werden erneut versucht. Wiederholungen folgen der lokalen
  Kalenderzeit auch über Zeitumstellungen. James muss zur Zustellung laufen;
  während er beendet ist, zeigt Windows diese App-Erinnerungen nicht automatisch.
- **Agent:** Suche in gespeicherten Gesprächsabschriften, zehn Werkzeugrunden,
  bessere Ergebnisprüfung, keine ungeprüften Erfolgsmeldungen. Delegierte Aufgaben
  verwenden den gewählten ChatGPT-/Ollama-/Hermes-Weg, wenn dieser gewählt ist.
  Abbrüche werden in untergeordnete Werkzeuge weitergegeben; wiederholte identische
  Fehlversuche sind begrenzt.
- **Aufräumen:** Der ungenutzte native nut.js-Zweig und seine optionalen Pakete
  wurden entfernt. Tests und Diagnoseprofile sind vom Installer ausgeschlossen.
  Die Windows-Steuerung über PowerShell bleibt verfügbar.

## Hermes aus dem ZIP

Der vollständige Hermes-Quellstand wurde separat installiert unter
`%LOCALAPPDATA%\Void James Hermes\hermes-agent-main`, mit eigener
Python-Umgebung unter `venv` und eigenem Datenprofil unter `profile`. Eine bereits
vorhandene andere Hermes-Installation wurde nicht ersetzt. Konten wurden nicht
kopiert. Die Quelle ist MIT-lizenziert; ihre Lizenzdatei bleibt in der Installation.

In James unter Stimme den Denkmotor Hermes auswählen. Der lokale Gateway startet
bei Bedarf automatisch. James übernimmt Mikrofon, Spracherkennung und Ausgabe;
Hermes übernimmt die Agentenarbeit, seine eigenen Werkzeuge und sein eigenes
Gedächtnis. Der API-Schlüssel wird von James erzeugt und verschlüsselt gespeichert.
Die Anbindung akzeptiert nur lokale Gateway-Adressen und keine HTTP-Weiterleitungen.
Abbruch fordert `/v1/runs/{id}/stop` an, auch wenn die Startantwort verspätet kommt.
Ohne James-Bestätigungen werden Hermes-Werkzeugfreigaben für den jeweiligen Auftrag
automatisch erteilt. Hermes kann weiterhin eigene Werkzeug-Sperren haben.

| Hermes-Funktionsbereich | Verfügbarkeit in diesem Stand |
|---|---|
| Werkzeug-Agent, Skills und Lernen | Original-Hermes-Motor eingebunden; abhängig vom eingerichteten Modell und den aktivierten Werkzeugen |
| Gedächtnis und frühere Sitzungen | Eigenes Hermes-Profil; James-Abschriften/Gedächtnis werden nicht automatisch importiert |
| Zeitpläne und Cron-Aufgaben | Original-Scheduler vorhanden; Gateway muss laufen; James-Erinnerungen zusätzlich direkt verfügbar |
| Delegation und mehrere Aufgaben | Original-Hermes-Funktionen plus verbesserte James-Unteragenten |
| Dateien, Terminal, Browser, Suche, MCP | Originalmodule vorhanden; Server, Browser, Pakete und API-Zugänge abhängig vom gewählten Werkzeug |
| Messaging und externe Kanäle | Originaladapter vorhanden; Konten, Tokens und teils optionale Pakete müssen eingerichtet werden |
| Docker/SSH und weitere Ausführungsumgebungen | Original-Unterstützung vorhanden; die jeweiligen Laufzeiten/Konten sind nicht eingerichtet |
| Sprache in James | Vorhandene James-Sprachmotoren; Hardwaretest und ggf. lokale Sprachmodelle erforderlich |

Es wurde die Paketgruppe `[all]` installiert, einschließlich der darin enthaltenen
MCP-/Web-/Google-/Cron-Erweiterungen und `aiohttp` für den API-Server. `[all]`
enthält laut Hermes-Quelle nicht jede optionale Messenger-, Wakeword- oder
Cloud-Gedächtnis-Abhängigkeit. Alle Originalmodule sind im Quellstand vorhanden;
das ist keine Zusage, dass sämtliche externen Dienste bereits angemeldet sind.
Hermes liefert in der James-Anbindung derzeit den fertigen Antworttext; ein
Live-Stream seiner Zwischenantworten und eine gemeinsame James/Hermes-Aufgabenliste
sind noch nicht umgesetzt.

Installation/Reparatur ist mit `scripts/install-hermes.ps1` reproduzierbar. Das
Skript prüft Archivpfade gegen Ausbruch aus dem Zielordner. Es aktualisiert in
dieser separaten Kopie PyJWT auf 2.15.1 und HTTPX2 auf 2.13.1 und ergänzt
aiohttp 3.14.3. Diese Änderungen beseitigten die gemeldeten Python-Paket-Advisories.
Versionsreferenzen: [PyJWT](https://pypi.org/project/PyJWT/),
[HTTPX2](https://pypi.org/project/httpx2/). Der lokale Installer enthält die
James-Anbindung; die externe Python-Installation wird nicht darin gebündelt.

## Prüfung

- Gesamte JavaScript-/TypeScript-Testsuite: **1.611 Tests bestanden**, keine Fehler.
  Enthalten sind echte Controller-/Session-Tests mit simuliertem Audio/Netzwerk,
  Sprechbeginn bei Half-Duplex, sofortiger Anfrageabbruch, anschließender neuer
  Beitrag und Schutz gegen verspätete Aktionen.
- Erinnerungen: Neustart/Persistenz, fehlgeschlagene Zustellung, keine Doppel-
  Zustellung, Verschieben, Wiederholung, Zeitzone und ungültige Kalendertage getestet.
- Werkzeugabbruch: Ein tatsächlich gestartetes Testwerkzeug bekommt sein
  Abbruchsignal und meldet einen Abbruch statt Erfolg. Vorher abgebrochene
  Unteragenten starten keine Modellanfrage.
- Hermes-Protokoll: Lokaler HTTP-Test für Aufträge, Kontext, automatische Freigaben,
  beaufsichtigten Modus und serverseitigen Stopp nach verspäteter Startantwort.
- Echter Electron-Start in isoliertem Profil: ChatGPT-Einrichtung sichtbar,
  ungültige Einstellung abgewiesen, autonomer Standard aktiv, Erinnerung per IPC
  angelegt/erledigt, **echter installierter Hermes-Gateway gestartet und erreichbar**.
  Das Mikrofon wurde in diesem Test absichtlich gesperrt; die erwartete Meldung
  beweist keinen Hardwarefehler. Es wurde keine bezahlte Modellanfrage ausgelöst.
- Hermes-Pakete: **113 Pakete kompatibel; pip-audit meldet 0 bekannte
  Schwachstellen**. Dies ist eine Paketprüfung, keine vollständige Sicherheits-
  Prüfung aller 18.416 ZIP-Einträge oder sämtlicher Hermes-Werkzeuge.
- Node-Audit: 8 hohe transitive Meldungen in der Build-Kette um
  `http-cache-semantics`; der vorgeschlagene Wechsel würde electron-builder
  zurückstufen. Keine ungeprüfte Zwangsänderung vorgenommen. Die produktiven
  Node-Abhängigkeiten wurden erneut geprüft: 0 Meldungen.
- Dateiprotokoll: Fehler durch geschlossene Terminal-Pipes behoben und mit
  Regressionstest abgesichert. Das Dateiprotokoll läuft ohne Exception-Schleife weiter.

Die Rohprotokolle liegen unter `out/audit/` und werden nicht ausgeliefert.
Typecheck und Produktions-Build sind erfolgreich. Der lokale Windows-Installer
`dist/Void James Setup 1.2.0.exe` wurde erfolgreich gebaut. Sein App-Archiv enthält
die Hermes-, Erinnerungs- und Werkzeugabbruch-Anbindung und keine Test-/Auditdateien.
SHA256: `1896E92F4DB0191BDD0401593D44863B03081F7398F40192FEEB5DDAA9C63D51`.
Der Installer wurde nicht installiert oder veröffentlicht und ist nicht codesigniert.
Die automatische Freigabeprüfung blockierte das rekursive Entfernen temporärer
Diagnoseprofile mit „blocked by policy“. Die Profile bleiben unter `out/audit/`
und sind vom Installer ausgeschlossen.

## ChatGPT-Anmeldung, Limits und Live

Die offizielle Anmeldung ist implementiert und ihre Einrichtung im echten
Electron getestet. Eine vollständige Anmeldung mit deinem Konto und echte
Modellantworten wurden nicht durchgeführt. OpenAI setzt die Konto-Limits durch;
James umgeht sie nicht. Sprachunterhaltung mit dem Abo verwendet Whisper,
ChatGPT-Textantworten und Piper. Natives OpenAI Realtime-Audio benötigt einen
separat abgerechneten API-Schlüssel; der Abo-Weg bietet in dieser Preview keine
Audioeingabe/Transkription. Quellen: [Anmeldung](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
und [Preview-Grenzen](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
Hermes-Modellkonten werden getrennt im eigenen Hermes-Profil eingerichtet.

## Nächste Verbesserungen, nach Nutzen

1. Echte Kontoanmeldung und anschließend ein kurzer Mikrofon-/Lautsprechertest:
   Satz unterbrechen, neue Frage stellen, Headset wechseln, Offline/Online prüfen.
   Der automatische Test kann Echo und Raumgeräusche nicht vollständig abbilden.
2. `hey_james.onnx` trainieren/bereitstellen. Der Klassifikator fehlt weiterhin;
   Klick und Hotkey funktionieren, das benannte Weckwort ist nicht einsatzbereit.
3. Gemeinsame Oberfläche für James- und Hermes-Zeitpläne, sichtbare Hermes-
   Werkzeugfortschritte und gestreamte Antwortausgabe ergänzen.
4. Backup/Export sowie Aufbewahrungsregeln für beide Datenprofile ergänzen.
5. Gepatchte Build-Abhängigkeiten, Codesignatur, Installer-/Updater-Testkanal.

Hermes erkennt auf diesem Rechner zusätzlich die SQLite-Version 3.50.4 der
Python-Installation als vom WAL-Reset-Problem betroffen und verwendet dafür
automatisch den DELETE-Journalmodus. Die globale Python-Installation wurde
nicht verändert. Ein aktualisierter isolierter Python-Laufzeitstand wäre ein
weiterer sinnvoller Wartungsschritt.
