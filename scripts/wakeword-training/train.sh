#!/usr/bin/env bash
# Weckwort trainieren („Hey James" oder „Jarvis"). Läuft unter Linux/WSL mit NVIDIA-GPU, dauert einige Stunden.
#   bash scripts/wakeword-training/train.sh
# Wenig Plattenplatz (~6 GB statt ~30 GB, schwächeres Modell):
#   SLIM=1 bash scripts/wakeword-training/train.sh
# „Jarvis" statt „Hey James":
#   WAKE=jarvis bash scripts/wakeword-training/train.sh
# Ergebnis: work/out/<name>.onnx -> src/renderer/public/wakeword/<name>.onnx
set -euo pipefail
cd "$(dirname "$0")"
WAKE="${WAKE:-hey_james}"
CONFIG="$WAKE.yml"
[ "${SLIM:-}" = "1" ] && CONFIG="${WAKE}_slim.yml"
[ -f "$CONFIG" ] || { echo "Unbekanntes Weckwort: $WAKE (erwartet: hey_james, jarvis)"; exit 1; }
export SLIM
mkdir -p work && cd work

command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# piper-phonemize gibt es nur bis Python 3.10.
[ -d .venv ] || uv venv --python 3.10 .venv
source .venv/bin/activate

[ -d openWakeWord ] || git clone --depth 1 https://github.com/dscripka/openWakeWord
[ -d piper-sample-generator ] || git clone --depth 1 https://github.com/rhasspy/piper-sample-generator
mkdir -p piper-sample-generator/models
[ -f piper-sample-generator/models/en-us-libritts-high.pt ] || curl -L -o piper-sample-generator/models/en-us-libritts-high.pt \
  https://github.com/rhasspy/piper-sample-generator/releases/download/v1.0.0/en-us-libritts-high.pt

uv pip install -q torch==2.3.1 torchaudio==2.3.1 --index-url https://download.pytorch.org/whl/cu121
uv pip install -q -e ./openWakeWord
uv pip install -q piper-phonemize==1.1.0 piper-tts webrtcvad-wheels mutagen==1.47.0 torchinfo==1.8.0 \
  torchmetrics==1.2.0 speechbrain==0.5.14 audiomentations==0.33.0 torch-audiomentations==0.11.0 \
  acoustics==0.2.6 pronouncing==0.2.0 datasets==2.14.6 deep-phonemizer==0.0.19 \
  pyroomacoustics soundfile scipy "numpy<2" onnx onnxruntime-gpu tensorflow-cpu==2.8.1 \
  onnx_tf==1.10.0 tensorflow_probability==0.16.0 protobuf==3.20.3
python -c "import openwakeword; openwakeword.utils.download_models(['__none__'])" || true

python ../prepare_data.py

python openWakeWord/openwakeword/train.py --training_config "../$CONFIG" --generate_clips
python openWakeWord/openwakeword/train.py --training_config "../$CONFIG" --augment_clips
python openWakeWord/openwakeword/train.py --training_config "../$CONFIG" --train_model

ls -la "out/$WAKE.onnx"
cp "out/$WAKE.onnx" ../../../src/renderer/public/wakeword/
echo "Fertig. In James unter Einstellungen → Zuhören das Modell $WAKE.onnx wählen."
