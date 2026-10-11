"""
Trainingsdaten für „Hey James" vorbereiten — nur aus Quellen, die eine
kommerzielle Nutzung erlauben. Lizenzen: README.md in diesem Ordner.

Erzeugt unter ./work:
  rirs/                 simulierte Raumimpulsantworten (pyroomacoustics, MIT)
  background/noise      MUSAN noise, 16 kHz (CC BY 4.0)
  background/music      MUSAN music, 16 kHz (CC BY 4.0)
  features/*.npy        openWakeWord-Merkmale der Negativbeispiele
"""

import os
import random
import subprocess
import tarfile
import urllib.request
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

WORK = Path(__file__).parent / "work"
SR = 16000
WINDOW = 16  # Merkmalsfenster, das openWakeWord-Modelle sehen (1,28 s)

LIBRISPEECH_TRAIN = "https://www.openslr.org/resources/12/train-clean-100.tar.gz"
LIBRISPEECH_DEV = "https://www.openslr.org/resources/12/dev-clean.tar.gz"
MUSAN = "https://www.openslr.org/resources/17/musan.tar.gz"
TATOEBA_DE = "https://downloads.tatoeba.org/exports/per_language/deu/deu_sentences.tsv.bz2"
LIBRISPEECH_TEST = "https://www.openslr.org/resources/12/test-clean.tar.gz"
# SLIM=1: für wenig Plattenplatz (~5 GB statt ~30 GB). Statt train-clean-100
# und MUSAN nur test-clean, künstliches Rauschen und Stimmengewirr aus
# LibriSpeech. Das Weckwort löst damit etwas öfter fälschlich aus, vor allem
# bei Musik — für ein erstes Modell reicht es.
SLIM = os.environ.get("SLIM") == "1"
THORSTEN = "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx"


def download(url: str, target: Path) -> Path:
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"lade {url}")
    tmp = target.with_suffix(target.suffix + ".part")
    urllib.request.urlretrieve(url, tmp)
    tmp.rename(target)
    return target


def extract(archive: Path, into: Path) -> None:
    marker = into / f".{archive.name}.done"
    if marker.exists():
        return
    into.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        tar.extractall(into, filter="data")
    marker.touch()


def load16k(path: Path) -> np.ndarray:
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != SR:
        audio = resample_poly(audio, SR, sr).astype("float32")
    return audio


def make_rirs(n: int = 400) -> None:
    import pyroomacoustics as pra

    out = WORK / "rirs"
    if out.exists() and len(list(out.glob("*.wav"))) >= n:
        return
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(1)
    for i in range(n):
        dims = [rng.uniform(3, 8), rng.uniform(3, 7), rng.uniform(2.4, 3.5)]
        rt60 = rng.uniform(0.15, 0.8)
        absorption, max_order = pra.inverse_sabine(rt60, dims)
        room = pra.ShoeBox(dims, fs=SR, materials=pra.Material(absorption), max_order=min(max_order, 30))
        pos = lambda: [rng.uniform(0.5, d - 0.5) for d in dims]  # noqa: E731
        room.add_source(pos())
        room.add_microphone(pos())
        room.compute_rir()
        rir = np.asarray(room.rir[0][0], dtype="float32")
        sf.write(out / f"rir_{i:04d}.wav", rir / (np.abs(rir).max() + 1e-9), SR)


def musan_background() -> None:
    if not (WORK / "dl" / "musan").exists():
        archive = download(MUSAN, WORK / "dl" / "musan.tar.gz")
        extract(archive, WORK / "dl")
    for kind in ("noise", "music"):
        out = WORK / "background" / kind
        if out.exists() and any(out.iterdir()):
            continue
        out.mkdir(parents=True, exist_ok=True)
        for wav in sorted((WORK / "dl" / "musan" / kind).rglob("*.wav")):
            # MUSAN liegt schon in 16 kHz vor; eine Verknüpfung spart die Kopie
            # (rund 5 GB). Nur wo das nicht geht, umrechnen und schreiben.
            try:
                (out / wav.name).symlink_to(wav.resolve())
            except OSError:
                sf.write(out / wav.name, load16k(wav), SR)


def synthetic_background(babble_source: Path) -> None:
    """Rauschen (weiß, rosa, braun, Brummen) und Stimmengewirr statt MUSAN."""
    rng = np.random.default_rng(3)
    noise = WORK / "background" / "noise"
    if not (noise.exists() and any(noise.iterdir())):
        noise.mkdir(parents=True, exist_ok=True)
        n = SR * 20
        for i in range(60):
            white = rng.standard_normal(n).astype("float32")
            kind = i % 4
            if kind == 1:  # rosa: 1/f
                spec = np.fft.rfft(white)
                spec /= np.sqrt(np.arange(1, len(spec) + 1))
                sig = np.fft.irfft(spec, n)
            elif kind == 2:  # braun
                sig = np.cumsum(white)
                sig -= np.convolve(sig, np.ones(4000) / 4000, mode="same")
            elif kind == 3:  # Netzbrummen mit Oberwellen
                t = np.arange(n) / SR
                base = rng.choice([50.0, 60.0])
                sig = sum(np.sin(2 * np.pi * base * k * t) / k for k in range(1, 6)) + 0.1 * white
            else:
                sig = white
            sig = sig / (np.abs(sig).max() + 1e-9) * rng.uniform(0.2, 0.8)
            sf.write(noise / f"noise_{i:03d}.wav", sig.astype("float32"), SR)
    music = WORK / "background" / "music"
    if not (music.exists() and any(music.iterdir())):
        music.mkdir(parents=True, exist_ok=True)
        files = sorted(babble_source.rglob("*.flac"))
        for i in range(60):
            mix = np.zeros(SR * 20, dtype="float32")
            for path in rng.choice(files, size=5, replace=False):
                clip = load16k(path)[: len(mix)]
                mix[: len(clip)] += clip
            sf.write(music / f"babble_{i:03d}.wav", mix / (np.abs(mix).max() + 1e-9) * 0.6, SR)


def german_tts(n: int = 6000) -> Path:
    """Deutsche Sätze mit der Thorsten-Stimme (CC0) — der häufigste Fehlauslöser sind deutsche Gespräche."""
    out = WORK / "german_tts"
    if out.exists() and len(list(out.glob("*.wav"))) >= n:
        return out
    out.mkdir(parents=True, exist_ok=True)
    model = download(THORSTEN, WORK / "dl" / "de_DE-thorsten-medium.onnx")
    download(THORSTEN + ".json", WORK / "dl" / "de_DE-thorsten-medium.onnx.json")
    src = download(TATOEBA_DE, WORK / "dl" / "deu_sentences.tsv.bz2")
    import bz2

    lines = [l.split("\t")[2].strip() for l in bz2.open(src, "rt", encoding="utf-8") if l.count("\t") >= 2]
    rng = random.Random(2)
    rng.shuffle(lines)
    for i, sentence in enumerate(lines[:n]):
        target = out / f"de_{i:05d}.wav"
        if target.exists():
            continue
        subprocess.run(
            ["piper", "--model", str(model), "--output_file", str(target), "--length_scale", str(rng.uniform(0.85, 1.2))],
            input=sentence.encode("utf-8"),
            check=True,
            capture_output=True,
        )
    return out


def features(files: list[Path], target: Path, windowed: bool) -> None:
    """Merkmale berechnen. `windowed`: Fenster zu je 16 für das Training, sonst ein Strom für die Validierung."""
    if target.exists():
        return
    from openwakeword.utils import AudioFeatures

    extractor = AudioFeatures(device="gpu")
    chunks = []
    for i, path in enumerate(files):
        audio = (load16k(path) * 32767).clip(-32768, 32767).astype("int16")
        if len(audio) < SR * 2:
            continue
        emb = extractor._get_embeddings(audio)
        if windowed:
            for start in range(0, emb.shape[0] - WINDOW + 1, WINDOW // 2):
                chunks.append(emb[start : start + WINDOW])
        else:
            chunks.append(emb)
        if i % 500 == 0:
            print(f"{target.name}: {i}/{len(files)}")
    data = np.stack(chunks) if windowed else np.concatenate(chunks)
    target.parent.mkdir(parents=True, exist_ok=True)
    np.save(target, data.astype("float32"))
    print(f"{target.name}: {data.shape}")


def main() -> None:
    make_rirs()
    libri = WORK / "dl" / "LibriSpeech"
    feats = WORK / "features"

    if SLIM:
        for url in (LIBRISPEECH_TEST, LIBRISPEECH_DEV):
            name = url.rsplit("/", 1)[1]
            if (WORK / "dl" / f".{name}.done").exists():
                continue
            archive = download(url, WORK / "dl" / name)
            extract(archive, WORK / "dl")
            archive.unlink(missing_ok=True)  # Platz sparen, entpackt reicht
        # Liegt MUSAN schon entpackt da (früherer voller Lauf), echtes Rauschen
        # und echte Musik nehmen — das macht das Modell robuster gegen Musik.
        if (WORK / "dl" / "musan").exists():
            musan_background()
        else:
            synthetic_background(libri / "test-clean")
        features(sorted((libri / "test-clean").rglob("*.flac")), feats / "librispeech.npy", True)
        features(sorted((WORK / "background").rglob("*.wav")), feats / "musan.npy", True)
        features(sorted(german_tts(3000).glob("*.wav")), feats / "german_tts.npy", True)
        features(sorted((libri / "dev-clean").rglob("*.flac")), feats / "validation.npy", False)
        return

    musan_background()

    for url in (LIBRISPEECH_TRAIN, LIBRISPEECH_DEV):
        archive = download(url, WORK / "dl" / url.rsplit("/", 1)[1])
        extract(archive, WORK / "dl")

    features(sorted((libri / "train-clean-100").rglob("*.flac")), feats / "librispeech.npy", True)
    features(sorted((WORK / "dl" / "musan").rglob("*.wav")), feats / "musan.npy", True)
    features(sorted(german_tts().glob("*.wav")), feats / "german_tts.npy", True)
    # Validierung: Sprache, die das Training nie gesehen hat.
    features(sorted((libri / "dev-clean").rglob("*.flac")), feats / "validation.npy", False)


if __name__ == "__main__":
    main()
