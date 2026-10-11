"""Sprachdienst: Text rein, Ton raus.

Läuft als eigener Prozess neben der App, weil VibeVoice ein PyTorch-Modell ist
und Electron kein Python spricht. Der Hauptprozess startet ihn, der Renderer
redet über einen WebSocket auf 127.0.0.1 direkt mit ihm — an der Stelle liegt
der Ton, und ihn erst durch die IPC-Brücke zu schicken wäre ein Umweg mit
Zwischenkopien für nichts.

Warum satzweise und nicht am Stück:

    Am Stück      16,8 s Stille, dann 16,1 s Ton
    Satzweise      3,7 s Stille, dann lückenlos

Gemessen auf einer RTF 3050. Die Rechenzeit ist in beiden Fällen dieselbe —
nur kommt sie im zweiten Fall verteilt, und das Ohr wartet nur auf das erste
Stück. Der erste Abschnitt wird zusätzlich kurz gehalten (siehe `split_text`),
weil die Wartezeit fast genau der Tondauer dieses Abschnitts entspricht.

Fünf Diffusionsschritte sind gesetzt und nicht verhandelbar: Mit dreien
entgleist das Modell und erzeugte im Versuch 111 Sekunden Gebrabbel für einen
Text von siebzehn.

Protokoll (JSON rein, Binär raus):
    → {"type": "speak", "id": "...", "text": "..."}
    ← Binärrahmen: 16-bit-PCM, 24 kHz, mono — je ein Abschnitt
    ← {"type": "chunk", "id": "...", "seq": n, "ms": 1234}
    ← {"type": "done", "id": "..."}
    → {"type": "cancel", "id": "..."}      Barge-in
    → {"type": "voices"}
    ← {"type": "voices", "voices": [...]}
"""

import argparse
import asyncio
import copy
import json
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
import torch
import websockets
from transformers.cache_utils import DynamicCache
from transformers.modeling_outputs import BaseModelOutputWithPast

from vibevoice.modular.modeling_vibevoice_streaming_inference import (
    VibeVoiceStreamingForConditionalGenerationInference,
)
from vibevoice.processor.vibevoice_streaming_processor import VibeVoiceStreamingProcessor

SAMPLE_RATE = 24000

# Fünf. Siehe Modulkopf — darunter entgleist das Modell.
DDPM_STEPS = 5

# Ein erster Abschnitt von etwa dieser Länge kommt nach gut einer Sekunde. Die
# Wartezeit entspricht ungefähr der Tondauer des Abschnitts, also lohnt es,
# den ersten kurz zu halten und erst danach in ganzen Sätzen zu arbeiten.
FIRST_CHUNK_WORDS = 6

# Unter drei Wörtern wird das Modell laut Microsofts eigener Doku instabil.
MIN_CHUNK_WORDS = 3


def split_text(text: str) -> list[str]:
    """Text in Abschnitte zerlegen, der erste kurz.

    Gesprochen wird satzweise. Nur der allererste Abschnitt wird an einem
    Komma oder Gedankenstrich früher abgetrennt — er allein bestimmt, wie
    lange es still bleibt, bevor überhaupt etwas zu hören ist.
    """
    cleaned = " ".join(text.split())
    if not cleaned:
        return []

    # An Satzenden trennen, das Satzzeichen bleibt am Satz.
    sentences = [s.strip() for s in re.split(r"(?<=[.!?…])\s+", cleaned) if s.strip()]
    if not sentences:
        return []

    chunks: list[str] = []
    first = sentences[0]
    if len(first.split()) > FIRST_CHUNK_WORDS * 2:
        # Lang genug, dass sich das Aufteilen lohnt: an der ersten Zäsur nach
        # dem Mindestumfang trennen.
        parts = re.split(r"(?<=[,;:—–])\s+", first, maxsplit=1)
        if len(parts) == 2 and len(parts[0].split()) >= MIN_CHUNK_WORDS:
            chunks.append(parts[0])
            chunks.append(parts[1])
        else:
            chunks.append(first)
    else:
        chunks.append(first)
    chunks.extend(sentences[1:])

    # Zu kurze Stücke an den Nachbarn hängen, statt sie dem Modell einzeln
    # zuzumuten.
    merged: list[str] = []
    leading_short = ""
    for chunk in chunks:
        if not merged and len(chunk.split()) < MIN_CHUNK_WORDS:
            leading_short = (leading_short + " " + chunk).strip()
            continue
        if leading_short:
            chunk = leading_short + " " + chunk
            leading_short = ""
        if merged and len(chunk.split()) < MIN_CHUNK_WORDS:
            merged[-1] = merged[-1] + " " + chunk
        else:
            merged.append(chunk)
    if leading_short:
        if merged:
            merged[-1] = merged[-1] + " " + leading_short
        else:
            merged.append(leading_short)
    return merged


class Speaker:
    """Das geladene Modell samt Sprecherprofilen."""

    def __init__(self, model_path: str, voices_dir: Path, device: str) -> None:
        self.device = device
        self.voices_dir = voices_dir
        self.processor = VibeVoiceStreamingProcessor.from_pretrained(model_path)

        dtype = torch.bfloat16 if device == "cuda" else torch.float32
        # flash_attention_2 ist unter Windows praktisch nie vorhanden und muss
        # selbst gebaut werden. Es gleich mit sdpa zu versuchen erspart den
        # Fehlschlag samt Stacktrace bei jedem Start.
        self.model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
            model_path, torch_dtype=dtype, device_map=device, attn_implementation="sdpa"
        )
        self.model.eval()
        self.model.set_ddpm_inference_steps(num_steps=DDPM_STEPS)
        self._prompts: dict[str, object] = {}

    def voices(self) -> list[str]:
        return sorted(p.stem for p in self.voices_dir.glob("*.pt"))

    def _prompt(self, voice: str):
        """Sprecherprofil laden und behalten.

        `weights_only=False` ist nötig, weil torch ab 2.6 das Setzen von
        Einträgen auf einem ModelOutput im sicheren Entpacker ablehnt und
        `safe_globals` daran nichts ändert. Die mitgelieferten Profile wurden
        mit `pickletools.dis` geprüft: sie enthalten Tensoren, OrderedDict,
        DynamicCache und BaseModelOutputWithPast — keinen ausführbaren Code.
        Deshalb wird auch nur aus dem mitgelieferten Verzeichnis geladen und
        kein Pfad von außen angenommen.
        """
        if voice in self._prompts:
            return self._prompts[voice]
        path = self.voices_dir / f"{voice}.pt"
        if not path.is_file():
            raise ValueError(f"Unbekannte Stimme: {voice}")
        with torch.serialization.safe_globals([BaseModelOutputWithPast, DynamicCache]):
            prompt = torch.load(path, map_location=self.device, weights_only=False)
        self._prompts[voice] = prompt
        return prompt

    def synth(self, text: str, voice: str) -> bytes:
        """Ein Abschnitt zu 16-bit-PCM."""
        prompt = self._prompt(voice)
        inputs = self.processor.process_input_with_cached_prompt(
            text=text,
            cached_prompt=prompt,
            padding=True,
            return_tensors="pt",
            return_attention_mask=True,
        )
        for key, value in inputs.items():
            if torch.is_tensor(value):
                inputs[key] = value.to(self.device)

        with torch.inference_mode():
            out = self.model.generate(
                **inputs,
                max_new_tokens=None,
                cfg_scale=1.5,
                tokenizer=self.processor.tokenizer,
                generation_config={"do_sample": False},
                verbose=False,
                all_prefilled_outputs=copy.deepcopy(prompt),
            )

        audio = out.speech_outputs[0]
        if audio is None:
            return b""
        samples = audio.detach().to(torch.float32).cpu().numpy().reshape(-1)
        # Begrenzen statt normalisieren: Normalisieren würde die Lautstärke
        # zwischen zwei Abschnitten springen lassen, und das hört man an jeder
        # Satzgrenze.
        samples = np.clip(samples, -1.0, 1.0)
        return (samples * 32767.0).astype("<i2").tobytes()


async def run_job(ws, speaker: Speaker, job: str, text: str, voice: str, lock: asyncio.Lock, cancelled: set[str]) -> None:
    """Eine Äußerung abschnittweise sprechen.

    Läuft als eigene Aufgabe, damit die Empfangsschleife weiterliest. Genau
    daran hing das Barge-in: Solange die Synthese in derselben Schleife lief,
    wurde `cancel` erst gelesen, wenn ohnehin schon alles gesprochen war — der
    Abbruch kam also immer zu spät, um etwas zu verhindern.
    """
    chunks = split_text(text)
    try:
        for seq, chunk in enumerate(chunks):
            if job in cancelled:
                break
            # Nur eine Synthese zur Zeit: Zwei gleichzeitige Läufe auf sechs
            # Gigabyte Grafikspeicher machen beide langsamer, statt einen
            # davon früher fertig.
            async with lock:
                if job in cancelled:
                    break
                started = time.time()
                pcm = await asyncio.to_thread(speaker.synth, chunk, voice)
            if job in cancelled or not pcm:
                continue
            await ws.send(pcm)
            await ws.send(
                json.dumps(
                    {
                        "type": "chunk",
                        "id": job,
                        "seq": seq,
                        "ms": round(len(pcm) / 2 / SAMPLE_RATE * 1000),
                        "computeMs": round((time.time() - started) * 1000),
                    }
                )
            )
    except websockets.exceptions.ConnectionClosed:
        return
    except Exception as err:  # noqa: BLE001 — die Meldung gehört zum Client
        try:
            await ws.send(json.dumps({"type": "error", "id": job, "message": str(err)[:300]}))
        except websockets.exceptions.ConnectionClosed:
            return
    finally:
        cancelled.discard(job)
        try:
            await ws.send(json.dumps({"type": "done", "id": job}))
        except websockets.exceptions.ConnectionClosed:
            pass


async def handle(ws, speaker: Speaker, default_voice: str, lock: asyncio.Lock, token: str) -> None:
    cancelled: set[str] = set()
    jobs: dict[str, asyncio.Task] = {}

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue

            kind = msg.get("type")

            # Eine Webseite kann trotz Loopback-Schnittstelle einen WebSocket
            # zu localhost öffnen. Ohne diese Prüfung könnte sie beliebig viele
            # GPU-Synthesen anstoßen. Der Schlüssel entsteht bei jedem
            # Dienststart neu und gelangt nur über Electrons IPC zum Renderer.
            if not token or msg.get("token") != token:
                await ws.close(code=1008, reason="Nicht autorisiert")
                return

            if kind == "cancel":
                # Barge-in. Der gerade laufende Abschnitt wird zu Ende
                # gerechnet — ihn mitten im Diffusionsschritt abzubrechen ginge
                # nur mit einem Rückruf ins Modell. Er wird nur nicht mehr
                # verschickt, und alle weiteren entfallen. Bei Abschnitten von
                # rund zwei Sekunden ist das kurz genug.
                if msg.get("id"):
                    cancelled.add(str(msg["id"]))
                continue

            if kind == "voices":
                await ws.send(json.dumps({"type": "voices", "voices": speaker.voices()}))
                continue

            if kind != "speak":
                continue

            job = str(msg.get("id", ""))
            text = str(msg.get("text", ""))
            voice = str(msg.get("voice") or default_voice)

            if not split_text(text):
                await ws.send(json.dumps({"type": "done", "id": job}))
                continue

            task = asyncio.create_task(run_job(ws, speaker, job, text, voice, lock, cancelled))
            jobs[job] = task
            task.add_done_callback(lambda _t, key=job: jobs.pop(key, None))
    finally:
        # Eine laufende `asyncio.to_thread`-Synthese lässt sich nicht wirklich
        # abbrechen: `task.cancel()` beendet nur das Warten, der Python-Thread
        # rechnet auf der GPU weiter. Dabei würde der Async-Lock freigegeben und
        # der nächste Client könnte dasselbe Modell gleichzeitig benutzen —
        # bis hin zu CUDA-Fehlern oder leerem Grafikspeicher. Deshalb alle
        # Aufträge als verworfen markieren und ihre aktuelle Synthese sauber
        # auslaufen lassen. Ton wird wegen `cancelled` nicht mehr verschickt.
        cancelled.update(jobs.keys())
        if jobs:
            await asyncio.gather(*list(jobs.values()), return_exceptions=True)


async def main() -> None:
    parser = argparse.ArgumentParser(description="VibeVoice-Sprachdienst für Void James")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--model", default="microsoft/VibeVoice-Realtime-0.5B")
    parser.add_argument("--voices", required=True, help="Verzeichnis mit den .pt-Sprecherprofilen")
    parser.add_argument("--voice", default="de-Spk0_man")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--token", required=True)
    args = parser.parse_args()

    voices_dir = Path(args.voices)
    if not voices_dir.is_dir():
        print(json.dumps({"status": "error", "message": f"Stimmen nicht gefunden: {voices_dir}"}), flush=True)
        sys.exit(1)

    print(json.dumps({"status": "loading", "device": args.device}), flush=True)
    speaker = Speaker(args.model, voices_dir, args.device)

    # Zweimal durchlaufen lassen, mit einem Satz normaler Länge.
    #
    # Der erste Aufruf enthält die CUDA-Initialisierung und dauert ein
    # Vielfaches. Ein sehr kurzer Satz reicht dafür nicht: Gemessen brauchte
    # der erste echte Abschnitt nach einem Aufwärmen mit "Bereit." noch das
    # 1,44-fache seiner Tondauer, die folgenden nur das 0,85-fache. Ein Satz
    # in Gesprächslänge stößt an, was ein Wort nicht anstößt — und der zweite
    # Durchlauf zeigt, dass es wirklich warm ist.
    warmup = "Guten Abend, der Rechner ist wach und alle Dienste laufen."
    try:
        for _ in range(2):
            speaker.synth(warmup, args.voice)
    except Exception as err:  # noqa: BLE001
        print(json.dumps({"status": "error", "message": str(err)[:300]}), flush=True)
        sys.exit(1)

    lock = asyncio.Lock()

    async def serve(ws):
        await handle(ws, speaker, args.voice, lock, args.token)

    # Nur auf der Rückschleife. Der Dienst hat keine Anmeldung, und das ist in
    # Ordnung, solange er von außen nicht erreichbar ist.
    async with websockets.serve(serve, "127.0.0.1", args.port, max_size=4 * 1024 * 1024):
        print(json.dumps({"status": "ready", "port": args.port, "voices": speaker.voices()}), flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
