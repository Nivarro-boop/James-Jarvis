# Karten-Engine und Antwortkarten — Prüfung 09.10.2026

Implementiert: eigener Canvas-Zeichner mit eigenem Protobuf/MVT-Decoder, Mercator-Projektion, Kacheleinpassung, Überzoom bis 18, Ziehen/Zoomen, Beschriftungen, nummerierten Markern und Routenlinien. OpenFreeMap-Kacheln kommen ausschließlich über IPC aus dem Hauptprozess und werden auf Platte gespeichert. Bei fehlender Kartengrundlage bleiben Marker und Route sichtbar.

Eigene Wegsuche: Overpass liefert OSM-Knoten und Straßen; A* mit Binärheap minimiert die geschätzte Dauer. Auto, Fahrrad und Fußwege berücksichtigen Straßenarten, einfache Zugangsbeschränkungen, Einbahnstraßen, Fahrradausnahmen und Höchstgeschwindigkeiten. Ortssuche nutzt Photon, bei Ortsnamen Open-Meteo als Rückfall; bekannte Einrichtungskategorien nutzen Overpass. Anfragen haben Zeitlimits, Abbruchsignale, User-Agent und einen Tagescache. Overpass weicht auf einen zweiten Server aus.

Antwortkarten: Aktien, Wetter, Orte, Routen, Termine und Suchquellen. Kalender und Websuche senden Karten über den bestehenden Runner; die ausführliche Wetteranzeige bleibt erhalten. Aktionen können eine Nachfrage auslösen oder einen HTTPS-Link öffnen. Gleichnamige IDs ersetzen Karten, Aktien werden auch nach Symbol zusammengeführt. Ausblenden und Ablauf nach fünf Minuten für die allgemeine Kartenliste.

Prüfung:
- TypeScript für Hauptprozess und Renderer bestanden.
- Vollständige Testsuite: 1.799 Tests bestanden.
- Produktionsbuild mit electron-vite bestanden; bestehende Bundle-Größenwarnungen.
- Electron-UI-Test mit isoliertem Profil: echte Vektorkacheln, Route/Orte/Quellen/Termine, Ziehen/Zoomen, Ausblenden und Abweisung von javascript-Links bestanden; keine Rendererfehler.
- Screenshot: out/audit/maps-answer-cards.png.
- Live-Ortsauflösung wurde durchgeführt. Live-Overpass-Abfrage konnte wegen HTTP-Fehlern der öffentlichen Server nicht abgeschlossen werden. Eine echte Route und POI-Abfrage bleiben damit extern unbestätigt.

Grenzen:
- Routen bis 300 km Luftlinie; ein begrenzter Ausschnitt kann einen weit außerhalb verlaufenden Umweg übersehen.
- Start und Ziel werden auf vorhandene Straßenknoten innerhalb 2 km gesetzt. Entfernung und Dauer beziehen sich auf diese Knoten; Anschlusswege von einer Haustür sind nicht enthalten.
- Keine aktuelle Verkehrslage, keine Abbiegeanweisungen. Abbiegerestriktionen, bedingte Sperren, Fähren, Höhenprofile und fahrzeugspezifische Maße werden derzeit nicht ausgewertet. Deshalb dient die Route als Übersicht und Zeitschätzung, nicht als vollständige Navigation.
- Öffentliche Datendienste können nicht verfügbar sein; der Fehler wird an das Werkzeug weitergegeben, statt einen erfundenen Weg auszugeben.

Wiederholen: npm run typecheck; npm test; npx electron-vite build; node scripts/check-maps-ui.cjs.
