# Weckwort „Hey James"

Das geplante Modell `src/renderer/public/wakeword/hey_james.onnx` fehlt im
geprüften Checkout vom 3. Oktober 2026. Es muss selbst trainiert und vor dem
Build dorthin kopiert werden. Die unten beschriebene Datenherkunft ist der
Trainingsplan; ein fertiges Modell wurde in dieser Prüfung nicht verifiziert.
Die vortrainierten openWakeWord-Modelle (`hey_jarvis`, `alexa`,
`hey_rhasspy`) stehen unter CC BY-NC-SA 4.0 und dürfen in einem verkauften
Programm nicht verwendet werden. Deshalb sind sie entfernt.

Neu trainieren (Linux oder WSL, NVIDIA-GPU, einige Stunden):

    bash scripts/wakeword-training/train.sh

„Jarvis" (oder „Hey Jarvis") statt „Hey James":

    WAKE=jarvis bash scripts/wakeword-training/train.sh

Das Skript kopiert `jarvis.onnx` am Ende nach `src/renderer/public/wakeword/`.
James nimmt es automatisch, sobald das eingestellte Modell fehlt. Danach
`npm run dist` und den neuen Installer installieren.

Ohne eigene NVIDIA-GPU: eine gemietete Cloud-GPU (z. B. RunPod, Vast.ai,
Lambda) mit Ubuntu und ca. 40 GB Platte reicht. Repository dort klonen,
obigen Befehl starten, `jarvis.onnx` herunterladen und in den Ordner legen.
Mit `SLIM=1` reichen ca. 6 GB Platte, das Modell wird etwas schwächer.

## Herkunft der Daten

Alle Quellen erlauben eine kommerzielle Nutzung. Die Daten selbst werden nicht
mitgeliefert, nur das daraus trainierte Modell.

| Zweck | Quelle | Lizenz |
|---|---|---|
| Trainingscode | openWakeWord (dscripka) | Apache-2.0 |
| Vorstufen `melspectrogram.onnx`, `embedding_model.onnx` | openWakeWord, Google speech_embedding | Apache-2.0 |
| Positive Beispiele „hey james" | piper-sample-generator, Modell `en-us-libritts-high` auf LibriTTS | Code MIT, Daten CC BY 4.0 |
| Negativbeispiele Englisch | LibriSpeech train-clean-100, dev-clean (openslr.org/12) | CC BY 4.0 |
| Negativbeispiele Deutsch | Tatoeba-Sätze, gesprochen mit Piper „thorsten" | Sätze CC BY 2.0 FR, Stimme CC0 |
| Hintergrund (Rauschen, Musik) | MUSAN (openslr.org/17) | CC BY 4.0 |
| Raumhall | simuliert mit pyroomacoustics | MIT |

Bewusst **nicht** verwendet: die ACAV100M-Merkmale und der Validierungssatz aus
dem openWakeWord-Beispiel, weil ihre Lizenz ungeklärt ist.

Die CC-BY-Quellen verlangen eine Namensnennung. Sie steht in
`THIRD_PARTY_NOTICES.md` im Hauptordner.
