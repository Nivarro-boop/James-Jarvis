# Globaler Sparmodus

Der vorhandene Schalter `tokenSaver.enabled` begrenzt jetzt mehrere Verbrauchsquellen:

- ChatGPT, Gemini-Text/Audio-Beiträge und Ollama: höchstens vier Modellrunden je Beitrag statt zehn. Die letzte Runde erhält keine Werkzeuge und dient dem Abschluss. Eine gewöhnliche Frage benötigt weiterhin nur eine Anfrage.
- ChatGPT-Werkzeugbeschreibungen und verschachtelte Parameterbeschreibungen werden beim Versand gekürzt. Der reine Schema-Konverter bleibt unverändert.
- Gemini und Ollama behalten ältere vollständige Gesprächsblöcke nur bis etwa 6.000 JSON-Zeichen und zwölf Nachrichten. Werkzeugaufrufe und Antworten bleiben zusammen. Große alte Audiobeiträge werden nicht erneut übertragen. Das kann den verfügbaren Gesprächskontext verkürzen; die aktuelle Frage bleibt vollständig.
- Gemini-Beiträge und Ollama-Ausgaben bekommen im Sparmodus ein Ausgabelimit von 700 Tokens. ChatGPT verwendet keine nicht unterstützten `max_output_tokens`-Parameter.
- Das System schickt vier statt zwölf Basisnotizen und keinen vollständigen Fertigkeitenindex. Gespeicherte Informationen bleiben vorhanden und können über Werkzeuge abgerufen werden.
- Automatisches modellbasiertes Hintergrundlernen und die wöchentliche automatische Gedächtniszusammenfassung pausieren im Sparmodus. Explizite Gedächtnispflege bleibt verfügbar; Erinnerungen und lokal gespeicherte Bedienabläufe laufen weiterhin automatisch.
- Unteragenten haben vier statt zehn Runden, kürzere Werkzeugbeschreibungen und einen Abschluss ohne neue Werkzeuge.
- Wenn ChatGPT im Abschlussereignis Nutzungszahlen liefert, werden Eingabe-, Ausgabe-, Cache- und Denk-Token als `chatgpt:usage` protokolliert. Dabei werden keine Gesprächsinhalte protokolliert.

Verifikation: 1.651 Tests bestanden, einschließlich echter Brain-Schleife mit simulierten IPC-Antworten (gewöhnliche Frage: eine Anfrage; Werkzeugschleife: vier), vollständigen Werkzeugpaaren, großen alten Audiobeiträgen, gekürzten ChatGPT-Schemas, ausbleibendem Hintergrundlernen und Tokenzahlen im SSE-Abschluss. Typprüfung und Produktionsbuild bestanden.

Es wurden keine realen Modellanfragen oder Kontingenttests ausgeführt. Deshalb gibt es keine gemessene prozentuale Einsparung und keinen Nachweis, warum das Konto des Nutzers nach einer Frage ein Limit meldet. Gemini Live, Hermes und spezialisierte Dienste wie Deep Research haben eigene Laufzeit- und Kostenmodelle; vier Runden sind kein universelles Token- oder Geldlimit. Das Kontingent des Codex-Chats wird durch Änderungen an James nicht beeinflusst.

Referenz: [OpenAI Docs: Einschränkungen der ChatGPT-Planfreigabe](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
