"""
Der gepflegte piper, als Dauerläufer.

Die eigenständige `piper.exe` stammt vom November 2023 aus einem archivierten
Projekt; weitergepflegt wird piper nur noch als Python-Paket. Dieses Skript ist
der Wirt dafür: Es lädt die Stimme genau einmal und beantwortet danach einen
Satz nach dem anderen. Der naheliegende Weg — je Satz ein `python -m piper` —
kostet zwischen einer und drei Sekunden für Auslegware und Modell, und die
lägen jedes Mal genau zwischen der Frage und dem ersten Wort der Antwort.

Zwei Dinge macht dieser Wirt anders als ein Skript, das man beiläufig
hinschreibt:

1. **stdout gehört den Rahmen, sonst niemandem.** Gleich zu Beginn wird der
   echte Ausgabekanal beiseitegelegt und Dateizeiger 1 auf stderr umgebogen.
   Alles, was irgendeine Bibliothek zu drucken für nötig hält — onnxruntime tut
   das gern und ungefragt —, landet danach bei den Meldungen statt mitten im
   Ton. Ohne diesen Griff genügt ein einziges `print` in fremdem Code, und aus
   Sprache wird ab dieser Stelle Rauschen.

2. **Jeder Block trägt seine Nummer.** Die .exe schreibt rohes PCM ohne jede
   Grenze; wo ein Satz aufhört, muss die Gegenseite an der Uhr raten. Hier
   steht es im Rahmen: Nummer, Art, Länge. Deshalb kann der Hauptprozess den
   Ton eines abgebrochenen Satzes sicher wegwerfen und weiß auf die
   Millisekunde, wann der nächste beginnen darf.

Der Rahmen, alles little-endian:

    Byte 0..3     b"PIP1"
    Byte 4..7     uint32  Nummer des Auftrags (0 bei „bereit")
    Byte 8..11    uint32  Art: 0 Ton, 1 Ende, 2 Fehler, 3 bereit
    Byte 12..15   uint32  Länge der Nutzlast in Byte
    danach        die Nutzlast

Ton ist rohes s16le-PCM in der Rate der Stimme; umgerechnet wird im
Hauptprozess, der weiß, was der Player verlangt. „Fehler" trägt einen ganzen
deutschen Satz und ersetzt das „Ende" — nach ihm kommt zu diesem Auftrag
nichts mehr. „bereit" trägt JSON mit der Abtastrate und ist das Zeichen, dass
das Modell geladen ist.

Hinein geht je eine Zeile JSON:

    {"id": 7, "text": "Guten Abend."}

Gelesen wird sie ausdrücklich als UTF-8 und nicht in der Windows-Codepage;
sonst verlieren die Umlaute unterwegs ihre Punkte. Aufgerufen wird das Skript
ausschließlich mit Pfaden, nie mit Einstellungen:

    python piper-host.py --voice <stimme.onnx> [--length-scale 1.0]

Rückgabewerte, die der Hauptprozess auswertet: 3 heißt „das Paket piper-tts
fehlt", 4 „die Stimme ließ sich nicht laden", 5 „so kann ich nicht starten".
Alles Menschliche geht als ganzer Satz auf stderr, mit „piper-host:" davor —
daran erkennt piper.ts, was es dem Nutzer zeigen darf und was bloß Geräusch
einer Bibliothek ist.
"""

import json
import os
import struct
import sys

MAGIC = b"PIP1"

KIND_AUDIO = 0
KIND_END = 1
KIND_ERROR = 2
KIND_READY = 3

EXIT_PACKAGE = 3
EXIT_VOICE = 4
EXIT_ARGS = 5


def note(text):
    """
    Ein Satz an piper.ts.

    Geschrieben wird als Bytes und nicht über den Textkanal: stderr steht unter
    Windows ohne Zutun auf der Codepage der Konsole, und ein „ä" darin wirft
    dann einen UnicodeEncodeError — ausgerechnet in der Meldung, die erklären
    soll, was schiefging.
    """
    line = ("piper-host: " + text + "\n").encode("utf-8", "replace")
    raw = getattr(sys.stderr, "buffer", None)
    if raw is None:
        sys.stderr.write(line.decode("utf-8", "replace"))
    else:
        raw.write(line)
    try:
        sys.stderr.flush()
    except Exception:
        pass


def claim_stdout():
    """
    Den echten Ausgabekanal an uns nehmen und Dateizeiger 1 nach stderr biegen.

    Danach kann keine Bibliothek mehr in den Tonstrom hineinreden: Was sie
    druckt, geht bei den Meldungen hinaus. Zurück kommt ein binär geöffneter
    Kanal — binär ist unter Windows keine Feinheit, sondern Bedingung, weil der
    Textmodus jedes 0x0A im PCM zu 0x0D 0x0A aufbläht und den Rahmen damit
    unbrauchbar macht.
    """
    keep = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    return os.fdopen(keep, "wb")


def send(out, kind, ident, payload=b""):
    """
    Einen Rahmen hinausschreiben.

    Gepuffert geschrieben und danach durchgedrückt: Ein Rahmen, der zur Hälfte
    hinausgeht, verschiebt alles Folgende um seine fehlenden Bytes, und der
    Empfänger findet nie wieder eine Kennung. Der gepufferte Kanal setzt eine
    unvollständige Schreibung von sich aus fort, der ungepufferte nicht.
    """
    out.write(MAGIC + struct.pack("<III", ident & 0xFFFFFFFF, kind, len(payload)))
    if payload:
        out.write(payload)
    out.flush()


def parse_args(argv):
    """Nur Pfade und Zahlen. Was hier nicht steht, ist keine Einstellung."""
    voice = ""
    length_scale = 1.0
    noise = {}
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--voice" and index + 1 < len(argv):
            voice = argv[index + 1]
            index += 2
        elif arg == "--length-scale" and index + 1 < len(argv):
            try:
                length_scale = float(argv[index + 1])
            except ValueError:
                note("Das Sprechtempo war keine Zahl. Ich nehme die Vorgabe der Stimme.")
            index += 2
        elif arg in ("--noise-scale", "--noise-w") and index + 1 < len(argv):
            try:
                noise[arg[2:].replace("-", "_")] = float(argv[index + 1])
            except ValueError:
                note("Die Klangangabe war keine Zahl. Ich nehme die Vorgabe der Stimme.")
            index += 2
        else:
            note("Die Angabe " + repr(arg) + " kenne ich nicht und übergehe sie.")
            index += 1
    return voice, length_scale, noise


def import_piper():
    """
    Das Paket holen — und beim Fehlen einen Satz hinterlassen, keinen Traceback.

    Der Import steht bewusst hier und nicht oben am Modul: Er darf erst laufen,
    wenn stdout in Sicherheit ist. Zurück kommt `SynthesisConfig` als `None`,
    wenn das Paket noch die alte Fassung ist — daran und nicht an einer
    Versionsnummer wird später der Weg gewählt.
    """
    try:
        from piper import PiperVoice
    except ImportError as err:
        note(
            "Das Python-Paket piper-tts fehlt (" + str(err) + "). Installiere es mit "
            '"pip install piper-tts" oder nimm in den Einstellungen unter Stimme die '
            "eigenständige Fassung."
        )
        return None, None
    except Exception as err:
        note("piper-tts ließ sich nicht laden: " + str(err))
        return None, None

    try:
        from piper import SynthesisConfig
    except Exception:
        # Bis piper-tts 1.2 gab es diese Klasse nicht; dort heißt der Weg
        # `synthesize_stream_raw`. Beide Fassungen sind im Umlauf, und welche
        # hier liegt, entscheidet der Rechner und nicht wir.
        SynthesisConfig = None

    return PiperVoice, SynthesisConfig


def audio_bytes(chunk):
    """
    Aus einem Stück Antwort rohes PCM machen.

    Ab piper-tts 1.3 kommt ein `AudioChunk` mit fertigen Bytes, davor kamen die
    Bytes selbst. Beides wird angenommen, weil beides im Umlauf ist.
    """
    data = getattr(chunk, "audio_int16_bytes", None)
    if data is not None:
        return bytes(data)
    array = getattr(chunk, "audio_int16_array", None)
    if array is not None:
        return array.tobytes()
    if isinstance(chunk, (bytes, bytearray, memoryview)):
        return bytes(chunk)
    raise TypeError("piper hat etwas geliefert, das kein Ton ist: " + type(chunk).__name__)


# Stille am Satzende, in Sekunden — derselbe Wert, den die eigenständige
# piper.exe von sich aus anhängt. Sie ist keine Verschwendung, sondern die
# einzige Lücke zwischen zwei Sätzen: Der Player im Renderer hängt die Blöcke
# ohne Pause aneinander, und ohne diese Stille klebte das Ende jedes Satzes am
# Anfang des nächsten. Ab piper-tts 1.3 gibt es den Regler nicht mehr; dort
# bleibt es bei dem, was die Fassung liefert — erfunden wird hier nichts.
SENTENCE_SILENCE = 0.2


def make_synth(voice, synthesis_config, length_scale, noise=None):
    """
    Einen Weg von Text zu Tonblöcken bauen, passend zur vorgefundenen Fassung.

    Ein Sprechtempo von genau eins wird ausdrücklich nicht weitergereicht: Es
    bedeutet „die Vorgabe der Stimme", und manche Stimmen bringen dafür einen
    anderen Wert als 1,0 mit. Wer die Eins durchreicht, überschreibt sie.
    """
    scale = None if abs(length_scale - 1.0) < 1e-6 else length_scale
    noise = noise or {}

    if synthesis_config is not None:
        options = {}
        if scale is not None:
            options["length_scale"] = scale
        if "noise_scale" in noise:
            options["noise_scale"] = noise["noise_scale"]
        if "noise_w" in noise:
            options["noise_w_scale"] = noise["noise_w"]
        config = synthesis_config(**options) if options else None

        def run(text):
            for chunk in voice.synthesize(text, syn_config=config):
                yield audio_bytes(chunk)

        return run

    if hasattr(voice, "synthesize_stream_raw"):

        def run(text):
            for chunk in voice.synthesize_stream_raw(
                text,
                length_scale=scale,
                noise_scale=noise.get("noise_scale"),
                noise_w=noise.get("noise_w"),
                sentence_silence=SENTENCE_SILENCE,
            ):
                yield audio_bytes(chunk)

        return run

    return None


def main(argv):
    voice_path, length_scale, noise = parse_args(argv)
    if not voice_path:
        note("Ohne --voice weiß ich nicht, womit ich sprechen soll.")
        return EXIT_ARGS
    if not os.path.exists(voice_path):
        note("Die Stimme " + os.path.basename(voice_path) + " liegt nicht da, wo sie stehen sollte.")
        return EXIT_VOICE

    out = claim_stdout()

    PiperVoice, synthesis_config = import_piper()
    if PiperVoice is None:
        return EXIT_PACKAGE

    try:
        voice = PiperVoice.load(voice_path)
        rate = int(voice.config.sample_rate)
    except Exception as err:
        note("Die Stimme " + os.path.basename(voice_path) + " ließ sich nicht laden: " + str(err))
        return EXIT_VOICE

    synth = make_synth(voice, synthesis_config, length_scale, noise)
    if synth is None:
        note(
            "Dieses piper-tts kennt weder synthesize noch synthesize_stream_raw. "
            "Aktualisiere das Paket oder nimm die eigenständige Fassung."
        )
        return EXIT_PACKAGE

    send(out, KIND_READY, 0, json.dumps({"rate": rate}).encode("utf-8"))

    # Zeilenweise binär gelesen und selbst nach UTF-8 gewandelt. Der Textkanal
    # von Python nimmt unter Windows die Codepage der Konsole, und aus „für"
    # wird dann „fÃ¼r" oder ein Fehler — beides mitten im Satz, den jemand
    # hören soll.
    stdin = getattr(sys.stdin, "buffer", sys.stdin)
    for raw in stdin:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            order = json.loads(line)
        except ValueError:
            note("Eine Zeile war kein JSON. Ich habe sie übergangen.")
            continue

        try:
            ident = int(order.get("id", 0))
        except (TypeError, ValueError):
            ident = 0
        text = str(order.get("text", "")).strip()

        # Ein leerer Auftrag bekommt trotzdem seinen Abschluss: Der
        # Hauptprozess wartet auf genau einen, und ohne ihn stünde die
        # Warteschlange bis zur Frist still.
        if not text:
            send(out, KIND_END, ident)
            continue

        try:
            for block in synth(text):
                if block:
                    send(out, KIND_AUDIO, ident, block)
            send(out, KIND_END, ident)
        except Exception as err:
            # Ein Satz, an dem sich piper verschluckt, ist kein Grund, den
            # Wirt zu beenden — der nächste gelingt meistens, und ein Neustart
            # kostet wieder das ganze Modell.
            send(
                out,
                KIND_ERROR,
                ident,
                ("piper konnte den Satz nicht sprechen: " + str(err)).encode("utf-8"),
            )

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(0)
    except BrokenPipeError:
        # Der Hauptprozess ist gegangen. Das ist kein Fehler, das ist Feierabend.
        sys.exit(0)
