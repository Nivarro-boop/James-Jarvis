# Prompt für eine Cloud-GPU-Sitzung: Weckwort-Modell trainieren

Für den Fall, dass das eingelernte Wort (3× sprechen) nicht genau genug ist
und ein richtiges openWakeWord-Modell gebraucht wird. In eine Cloud-Sitzung
mit NVIDIA-GPU (z. B. RunPod, Vast.ai, Lambda; Ubuntu, 40 GB Platte) geben:

---

Trainiere ein openWakeWord-Modell für das Weckwort „Hey James“ (deutsch und
englisch ausgesprochen) für eine kommerziell verkaufte Windows-App.

1. Repository Nivarro-boop/James-Jarvis klonen.
2. `bash scripts/wakeword-training/train.sh` ausführen (Standard ist hey_james;
   für „Hey Jarvis“ `WAKE=jarvis`). Die Konfiguration liegt in
   `scripts/wakeword-training/hey_james.yml`.
3. Nur Daten mit kommerziell nutzbarer Lizenz verwenden (siehe
   `scripts/wakeword-training/README.md`, Abschnitt „Herkunft der Daten“).
   Keine vortrainierten openWakeWord-Modelle (CC BY-NC-SA) einbinden.
4. Ergebnis prüfen: Falsch-Auslöser pro Stunde auf deutschem Sprach- und
   Musikmaterial unter 0,5; Trefferquote auf eigenen Testaufnahmen über 90 %.
5. Liefern: `hey_james.onnx` (Eingabe 1×16×96 Embeddings, Ausgabe ein Score
   0–1), dazu Trainingslog und die gemessenen Werte aus Punkt 4.

---

Die fertige Datei nach `src/renderer/public/wakeword/` legen, `npm run dist`,
neu installieren. In der Einrichtung wird „Hey James“ dann wählbar.
