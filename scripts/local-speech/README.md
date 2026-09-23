# Staging the local speech runtime

`server/local-speech-runtime.ts` reports the local voice capability unavailable
until two executables and three model files are present, and the preview flag
`features.localSpeech` is on. Nothing here is downloaded automatically and no
binary is checked in.

Verified end to end on `win32-x64` on 2026-09-23. Substitute your own platform
directory elsewhere.

## Models

```bash
pnpm build:speech-models
```

Downloads the pinned bundle into `dist-native/speech-models/` and verifies every
file against the SHA-256 in `server/speech-model-bundle.ts`. Both pinned models
are good: they were used for every check below.

## Speech to text: whisper.cpp

`third_party/local-speech/README.md` pins `ggml-org/whisper.cpp` v1.9.3. That
tag publishes source only, so either build it or take a binary from one of the
project's rolling `b####` releases, which do publish
`whisper-bin-x64.zip` for Windows.

Copy the whole `Release/` directory into
`dist-native/speech-runtime/<platform>-<arch>/`. The executable loads its
backend from sibling DLLs, so `whisper-cli.exe` alone is not enough.

Confirmed with the pinned `ggml-base-q5_1` model and the exact arguments the
server passes: whisper transcribed a real speech sample verbatim.

## Text to speech: the pinned CLI does not work

**`nazdridoy/kokoro-tts` v2.3.2 cannot read the model this repository pins.**
Verified, not inferred:

- `kokoro-tts` 2.3.2 declares `kokoro-onnx==0.3.9` as a hard dependency, and
  2.3.2 is its latest version.
- `kokoro-onnx` 0.3.9 feeds the graph an input named `tokens`.
- The pinned `kokoro-v1.0.int8.onnx` declares its inputs as
  `input_ids` (int64), `style` (float), `speed` (float).

The result is `Required inputs (['input_ids']) are missing from input feed
(['tokens', 'style', 'speed'])` and no audio at all. Upgrading `kokoro-onnx`
underneath it fails the other way: 0.6.1 reads the model correctly but has
dropped an API 2.3.2 calls.

The model is not at fault. `kokoro-onnx` 0.6.1 synthesizes from it correctly.
So the CLI is the piece that has to change, and `dani_kokoro_cli.py` here is a
minimal one over 0.6.1 implementing exactly the contract
`server/local-speech-runtime.ts` invokes.

```bash
uv venv .venv-kokoro
uv pip install --python .venv-kokoro/Scripts/python.exe --require-hashes -r scripts/local-speech/requirements.txt
uv pip install --python .venv-kokoro/Scripts/python.exe --no-deps scripts/local-speech
cp .venv-kokoro/Scripts/kokoro-cli.exe dist-native/speech-runtime/<platform>-<arch>/
```

`requirements.txt` is hash-locked, so the install is verified rather than
resolved afresh. The console script is a self-contained executable the server
can spawn directly, which matters because the runtime spawns the configured
path without a shell.

Then check the two halves still agree before trusting them:

```bash
dist-native/speech-runtime/<platform>-<arch>/kokoro-cli --selftest   --model dist-native/speech-models/kokoro/kokoro-v1.0.int8.onnx   --voices dist-native/speech-models/kokoro/voices/voices-v1.0.bin
```

It prints the model's declared inputs and synthesizes a sample, so a model or
library that moves is caught here rather than at the first attempt to speak.
Confirmed to fail, loudly and with the reason, against `kokoro-onnx` 0.3.9.

## Checking it

```bash
curl -s localhost:<port>/api/live-call/local/status
```

`{"enabled":true,"ready":true,...}` means both engines resolved. A round trip
through both endpoints was confirmed: `/api/live-call/local/speak` returned
audio, and feeding that audio straight back to
`/api/live-call/local/transcribe` returned the original sentence.
