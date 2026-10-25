# Browser-Auswahlfenster 1.3.23

- Das Öffnen des Browsers blendet das Gespräch und sein Textfeld nicht mehr automatisch ein.
- Das Browserfenster lässt sich an „Deine Auswahl“ innerhalb des James-Fensters verschieben, auch per Pfeiltasten. Die Position bleibt während der Sitzung erhalten und wird bei Größenänderungen begrenzt.
- browser_open lädt standardmäßig im Hintergrund. needsUserInput aktiviert die Anzeige für Anmeldung, Freigabe, Auswahl oder ausdrücklich gewünschte Anzeige.
- icloud_read öffnet keine sichtbaren Fenster mehr. Bei erforderlicher Eingabe verwendet James icloud_open. Manuelles Öffnen bleibt über Browser möglich.
- Schließen mit × blendet das Fenster aus; die Sitzung bleibt bestehen. Während des Verschiebens wird die native Webseite kurz ausgeblendet und anschließend an der neuen Position angezeigt.

Prüfung: TypeScript, 2170 Tests, Electron-Integration mit Mausziehen, Tastaturbewegung, verborgenem Textfeld, kleinen Fenstergrößen, Tabs, Navigation, Popups, Dialogschutz und Sitzungserhalt erfolgreich.
