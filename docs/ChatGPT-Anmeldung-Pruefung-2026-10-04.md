# ChatGPT-Anmeldung: Nachprüfung vom 4. Oktober 2026

Der vorhandene Anmeldeablauf wurde mit der offiziellen
[OpenAI-Anmeldeanleitung](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
abgeglichen. Die tatsächliche öffentliche OIDC-Konfiguration war erreichbar
(HTTP 200), mit dem erwarteten Aussteller und RS256-Signaturverfahren.
Es wurde keine Anmeldung in einem echten Benutzerkonto durchgeführt.

## Änderungen

- Ein laufender Anmeldeversuch lässt sich im Fenster abbrechen. Die Anforderung
  beendet die lokale Browserwartezeit oder den laufenden Tokenaustausch.
- Eine bestehende Verbindung hat einen Knopf zum erneuten Anmelden. Ein
  fehlgeschlagener neuer Versuch überschreibt die gespeicherte Anmeldung nicht.
- Bei `invalid_grant` startet einmalig ein frischer Browserablauf mit neuen
  State-, Nonce- und PKCE-Werten. Die von OpenAI bereits ausgestellte Client-ID
  und die Installationskennung bleiben erhalten. Ein wiederholter Fehler wird
  angezeigt, statt weitere Browserfenster zu öffnen.
- Fehler beim Tokenaustausch unterscheiden ungültige Codes, ungültige
  App-Registrierungen und nicht erlaubte Scopes. Rohe Tokenantworten werden
  weder angezeigt noch protokolliert.

## Nachweise

Zehn neue Tests verwenden den echten lokalen HTTP-Callback und echte
RSA-signierte Test-ID-Tokens. Browseröffnung und OpenAI-Tokenendpunkte werden
simuliert, ohne echte Konten oder Zugangsdaten anzufassen. Geprüft wurden:

1. Erstanmeldung, PKCE, identische Rückleitungsadresse beim Codeaustausch,
   Speicherung und Erneuerung der Zugangsdaten.
2. Wiederanmeldung mit gespeicherter Client-ID und stabiler Installationskennung.
3. Automatischer frischer Versuch nach abgelaufenem Code.
4. Begrenzung wiederholter Codefehler.
5. Ablehnung eines falschen State bei weiterhin erreichbarer korrekter Rückleitung.
6. Verweigerte Freigabe ohne Tokenaustausch.
7. Abbruch der Browserwartezeit mit anschließend erfolgreichem neuen Versuch.
8. Erhalt des bisherigen Kontos bei abweichender Identität im neuen ID-Token.
9. Abbruch während des Tokenaustauschs ohne Speicherung verspäteter Zugangsdaten.
10. Ablehnung eines fremden Nonce und fehlender Plan-Freigabe.

Die vollständige Testsuite besteht aus **1.639 bestandenen Tests**, ohne Fehler,
Abbrüche oder übersprungene Tests. TypeScript-Prüfung und Produktions-Build
sind erfolgreich. Tests und Builds liefen nacheinander mit niedriger Priorität;
die Tests beschränkten sich auf eine gleichzeitig laufende Testdatei.

Eine echte Kontoanmeldung und eine reale Modellantwort müssen noch im Browser
bestätigt werden. Es wurde kein Browserfenster auf dem Desktop geöffnet und
James wurde während des Spiels nicht gestartet. Die startbare Windows-Fassung
wird lokal unter `dist/win-unpacked` gebaut und nicht veröffentlicht.

Beim Prüfen des ersten Pakets wurde ein beschädigtes ASAR-Archiv erkannt:
ein Build-Protokoll unter `out/` wuchs während des Archivierens. Build-Logs
und Typprüfungs-Zwischendaten sind jetzt explizit vom Paket ausgeschlossen.
Das Windows-Paket wurde anschließend erneut erstellt: **7.628 Dateien** stimmen
mit ihren gespeicherten SHA-256-Prüfsummen überein. Das Paket enthält den neuen
Abbruchkanal, die Wiederholungslogik und beide neuen Anmeldeknöpfe. Testdateien,
Build-Logs und Typprüfungs-Zwischendaten sind nicht enthalten.
