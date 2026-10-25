# Apple Health, iCloud und Mail – 25.10.2026

**Aktualisierung 1.3.22:** Der unten beschriebene Chrome-Einstieg für iCloud wurde
durch einen Browser direkt in James ersetzt. Maßgeblich ist der
[aktuelle Bericht zum integrierten Browser](Integrierter-Browser-1.3.22.md).
Die folgenden Abschnitte dokumentieren den vorherigen Zwischenstand.

## Implementierter Stand

- Einstellungen → Verbindungen enthält „iCloud anmelden / öffnen“. Die Anmeldung erfolgt im eigenen James-Chrome-Profil, einschließlich Apples Zwei-Faktor- und Gerätefreigabe.
- `icloud_open` öffnet Mail, Kalender, Drive, Fotos, Kontakte, Notizen oder Erinnerungen. `icloud_read` liest sichtbaren Text einschließlich sichtbarer iCloud-App-Frames. Fremde und versteckte Frames werden übersprungen; die Textmenge ist begrenzt.
- Das Öffnen der Seite bestätigt keine Anmeldung. Leere oder noch ladende Inhalte bestätigen keinen leeren Posteingang. Es gibt keine vollständige Synchronisierung, keinen eigenen IMAP-/SMTP-Client und keinen eigenen automatischen iCloud-Mailversand.
- Gmail- und Yahoo-Wege bleiben vorhanden.
- Der bestehende HealthKit-Weg benötigt die native iPhone-App und eine Freigabe auf dem Gerät. Die gekoppelte Telefonverbindung übermittelt Zusammenfassungen an den Desktop; dort wird der letzte Stand verschlüsselt gespeichert, sofern Windows-Verschlüsselung verfügbar ist, andernfalls nur im Arbeitsspeicher.
- Im Health-Bereich lässt sich der aktuelle Empfangsstand erneut prüfen. Fehler beim Prüfen und Löschen werden angezeigt. James weist bei fehlenden Daten ausdrücklich auf die native App hin.

## Noch nötige Einrichtung und Prüfung

1. Aktuellen Desktop-Build verwenden und in den Verbindungen iCloud öffnen; beim Apple Account anmelden und gegebenenfalls Webzugriff auf dem Apple-Gerät erlauben.
2. Für Health die native iPhone-App bauen/installieren, mit dem Rechner koppeln und „Apple Health teilen“ einschalten. Die PWA kann keine HealthKit-Berechtigung anfordern.
3. Auf dem Desktop „Health-Verbindung prüfen“ und eine konkrete Wertefrage testen. Eine aktivierte Teilen-Einstellung belegt keine erteilten Health-Leserechte: Apple liefert bei verweigerten Leserechten keine Werte.
4. iCloud-Mail und Kalender im echten Konto testen. Diese Sitzung hat keine echte Kontoanmeldung oder iPhone-Geräteprüfung durchgeführt. Der Build ersetzt keine installierte App und keinen signierten iPhone-Build.

Apple-Dokumentation: [iCloud-Webzugriff und Health-Grenze](https://support.apple.com/en-gb/102630), [iCloud-Funktionen im Browser](https://support.apple.com/en-ie/105119), [IMAP-/SMTP-Einrichtung für einen späteren direkten Mailclient](https://support.apple.com/en-ie/102525).

## Prüfung

Desktop-Typecheck und Produktionsbuild erfolgreich. Gesamttests vor der abschließenden Health-Hinweisänderung: 2.150 bestanden, keine fehlgeschlagen. Zusätzliche iCloud-Tests prüfen Hostgrenzen, sichtbare App-Frames, ausgeblendete/fremde Frames, Textbegrenzung und die fehlende automatische Anmeldebestätigung.

Nach den letzten Änderungen: Typecheck, Produktionsbuild und 1.370 betroffene Health-/iCloud-/Schema-Prüfungen erfolgreich. Bestehende UI-Prüfung `check-redesign-ui.cjs` erfolgreich (isoliertes Profil, Startseite, kleines Fenster, Entwurfserhalt, Tastaturmenü, Quiz und Einstellungssuche). Keine echten Kontoanfragen in dieser UI-Prüfung.
