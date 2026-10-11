# Gesamtprüfung — Void James 1.2.12

Prüfdatum: 8. Oktober 2026. Der Prüfbereich umfasst die automatisierte Testsuite, TypeScript, Produktionsbuild, Electron-Oberfläche, lokale Weckwortmodelle, echte Mikrofonöffnung in der Ausführungsumgebung, gespeicherte Providerzugänge und Hermes-Installation. Es handelt sich nicht um eine Bestätigung sämtlicher externer Dienste oder aller gesprochenen Befehle.

| Bereich | Ergebnis | Aussagegrenze |
| --- | --- | --- |
| TypeScript | nachträglich als fehlgeschlagen erkannt | Der lokale Zustand der Weckwortanzeige deklarierte das Modellfeld nicht. In 1.2.13 korrigiert |
| Automatisierte Tests | 1.688 bestanden, 0 fehlgeschlagen | Enthalten simulierte Netzwerk-, Werkzeug- und Audiosignale |
| Produktionsbuild | bestanden | App lässt sich bauen |
| Electron-Oberfläche | bestanden | Hauptfenster, Diagnose, Log, Einstellungen, Alt, OpenAI-Zugangstest ohne Schlüssel, ElevenLabs-Einrichtung, keine Hermes-Auswahl |
| Doppelklatschen | Tests bestanden | Kurze Impulse, schwache Impulse, Reset, Einzelklatscher, lange Geräusche und falscher zeitlicher Abstand geprüft; kein echter Klatsch-Hörtest |
| Hey Jarvis | drei ONNX-Modelle ausführbar | PCM-/Feature-Pipeline geprüft; realer Modelllauf mit synthetischem Eingang. Kein Nachweis der Erkennung einer gesprochenen positiven Aufnahme |
| Hey James / James | nicht verfügbar | Kein eigener Klassifikator vorhanden. Tatsächlich wird Jarvis als Ersatzmodell verwendet |
| Echtes Mikrofon | fehlgeschlagen | Electron getUserMedia liefert NotFoundError: Requested device not found. In dieser Ausführungsumgebung kein nutzbares Standardmikrofon bestätigt |
| OpenAI / Gemini | blockiert | Im geprüften installierten Profil Schlüsselspeicher nicht lesbar; im Entwicklungsprofil fehlen Zugänge |
| ChatGPT-Anmeldung | nicht bestätigt | Installiertes Profil meldet nicht lesbar oder Netzfehler; Entwicklungsprofil nicht angemeldet |
| ElevenLabs | echte Sprache nicht bestätigt | Einrichtung und Ablehnungsanzeigen geprüft, kein erfolgreiches Gespräch/Hörprobe mit persönlichen Zugängen |
| Hermes | installiert, Gateway nicht erreichbar | Lokales Python findet hermes_cli und fastapi. HTTP-Gesundheitsprüfung auf Standardadresse 127.0.0.1:8642 nicht erfolgreich |
| Externe Aktionen | nicht vollständig ausgeführt | Keine echten E-Mails, Nachrichten, Zahlungen, Telefonate oder anderen Außenwirkungen zum Testen erzeugt |

## Behobene Fehler

Die Weckwort-Einstellungen versprachen bisher „Hey James“ und zeigten den konfigurierten statt des geladenen Klassifikators. Sie zeigen jetzt das tatsächlich gewählte Modell und dessen Weckwort an.

Der neue Zugangsblock wird beim Wechsel zwischen OpenAI und ElevenLabs neu aufgebaut. Dadurch bleiben eingegebene Schlüssel und Prüfergebnisse nicht irrtümlich beim anderen Anbieter stehen.

## Benötigte Schritte für einen vollständigen Hörtest

Ein nutzbares Mikrofon muss unter Windows und in den Audioeinstellungen verfügbar sein. Danach müssen Doppelklatschen und mehrfach gesprochenes „Hey Jarvis“ in Ruhe und bei Hintergrundgeräuschen getestet werden. Für „Hey James“ ist zunächst ein eigenes Modell erforderlich.

Die Zugänge müssen in der App erneut geprüft beziehungsweise eingerichtet werden. Für Hermes muss der Gateway gestartet und sein Modellprofil eingerichtet sein. Erst danach lassen sich echte Sprachantworten, Werkzeugausführung, Unterbrechen und Reparatur vollständig prüfen.

## Nachweise

Lokale Diagnoseausgaben: out/full-audit-typecheck.log, out/full-audit-tests.log, out/full-audit-build.log, out/audit/real-microphone.json und out/audit/provider-check-1.2.8.json. Der letzte Dateiname stammt vom ursprünglichen Prüfskript; die Prüfung wurde bei dieser Gesamtprüfung erneut ausgeführt. Keine Audiodatei wurde gespeichert.

Paketprüfung bestanden: Version 1.2.12, Oberfläche, Main-Prozess, drei Weckwortmodelle und Windows-Hilfsprogramme enthalten; keine Auditlogs im Paket. Windows-Installer erfolgreich gebaut und SHA256-Prüfsumme erstellt.
