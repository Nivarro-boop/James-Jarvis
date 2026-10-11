# GitHub-Update 1.3.2

Dieser Ordner enthält das geprüfte Update zum manuellen Hochladen in ein
[GitHub-Release von James-Jarvis](https://github.com/Nivarro-boop/James-Jarvis/releases).
Auf diesem PC ist Version **1.3.2** bereits installiert und gestartet.

Release-Titel: **James-Jarvis 1.3.2**. Tag: **v1.3.2**.
Als Beschreibung den Inhalt von [UPDATE.md](UPDATE.md) verwenden.
Das Release muss auf den Commit mit dem zugehörigen aktualisierten Quellcode zeigen.

Diese vier Dateien gemeinsam als Release-Anhänge hochladen:

| Datei | Zweck |
| --- | --- |
| `James-Jarvis-Setup-1.3.2.exe` | Windows-Installer |
| `James-Jarvis-Setup-1.3.2.exe.blockmap` | Metadaten für den Update-Download |
| `latest.yml` | Version, Dateiname, Größe und SHA-512 für automatische Updates |
| `James-Jarvis-Setup-1.3.2.exe.sha256` | SHA-256-Prüfsumme des Installers |

Die Dateinamen unverändert übernehmen: `latest.yml` verweist genau auf den
Installer mit Bindestrichen. Seine Größe beträgt **127.441.588 Bytes**.
SHA-256: `44C7328BCDA2787B2F09E9469791593E1E515E6147B0BE8580BB16A6B274A97B`.

Der Installer ist größer als 100 MiB und gehört deshalb in die Release-Anhänge.
GitHub blockiert solche Dateien im normalen Git-Repository; siehe
[GitHub-Dokumentation zu großen Dateien](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).
Die lokale `.gitignore` hält die Release-Anhänge aus dem Git-Commit heraus.
Diese Anleitung und `UPDATE.md` können mit dem Quellcode eingecheckt werden.

Der vorhandene GitHub-Workflow baut bei einem Push auf `main` selbst ein Release
und setzt die Patchversion auf seine Laufnummer. Das ist ein eigener neuer Build;
die hier vorbereiteten Dateien behalten die Version **1.3.2**.

Vorbereitet und lokal geprüft; noch nicht auf GitHub veröffentlicht.
