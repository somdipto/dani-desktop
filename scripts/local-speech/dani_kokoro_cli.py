"""Kokoro synthesis CLI matching the contract Dani's server invokes.

`server/local-speech-runtime.ts` spawns the configured text-to-speech binary as:

    kokoro-cli <input.txt> <output.wav> --model <onnx> --voices <bin>
               --voice <name> --lang <code> --format wav

Why this exists rather than the obvious upstream CLI: `nazdridoy/kokoro-tts`
v2.3.2, its latest release, hard-pins `kokoro-onnx==0.3.9`, and that version
feeds the ONNX graph an input named `tokens` while the model this repository
pins, `kokoro-v1.0.int8.onnx`, declares `input_ids`. The pair cannot work, and
the failure is silent in the worst way: the process exits successfully having
written no audio. `kokoro-onnx` is a library with no CLI of its own, so a thin
one over a current version is the smallest honest answer. Dependencies are
pinned with hashes in requirements.txt beside this file.

`--selftest` exists because that mismatch is invisible until someone tries to
speak. It proves the pinned model and the installed library still agree, and
says which side moved when they do not.
"""
import argparse
import sys

#: Inputs `kokoro-v1.0*.onnx` declares. A model or library that disagrees with
#: this is the drift that produced no audio at all before, so it is named here
#: rather than discovered at the first attempt to speak.
EXPECTED_INPUTS = {"input_ids", "style", "speed"}


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read().strip()


def selftest(model: str, voices: str) -> int:
    """Prove the pinned model and the installed library still fit together."""
    try:
        import onnxruntime as ort
    except ImportError as error:
        print(f"onnxruntime is not installed: {error}", file=sys.stderr)
        return 2

    try:
        session = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    except Exception as error:  # noqa: BLE001 - any failure here is fatal
        print(f"cannot open the model: {error}", file=sys.stderr)
        return 1

    names = {i.name for i in session.get_inputs()}
    print(f"model inputs: {sorted(names)}")
    if names != EXPECTED_INPUTS:
        print(
            f"model declares {sorted(names)} but this CLI targets {sorted(EXPECTED_INPUTS)}; "
            "the pinned model and this CLI have diverged",
            file=sys.stderr,
        )
        return 1

    # Names matching is necessary but not sufficient: dtypes and the voices
    # file have to line up too, and only a real synthesis proves that.
    try:
        from kokoro_onnx import Kokoro

        audio, rate = Kokoro(model, voices).create("Local speech is ready.", voice="af_heart", lang="en-us")
    except Exception as error:  # noqa: BLE001
        print(f"synthesis failed, so the pinned library cannot drive this model: {error}", file=sys.stderr)
        return 1

    seconds = len(audio) / rate if rate else 0
    if seconds <= 0:
        print("synthesis produced no audio", file=sys.stderr)
        return 1
    print(f"synthesis ok: {seconds:.2f}s at {rate} Hz")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="kokoro-cli", add_help=True)
    parser.add_argument("input", nargs="?")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--lang", default="en-us")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--format", default="wav", choices=["wav"])
    parser.add_argument("--selftest", action="store_true", help="check the model and library agree, then exit")
    args = parser.parse_args()

    if args.selftest:
        return selftest(args.model, args.voices)
    if not args.input or not args.output:
        parser.error("input and output are required unless --selftest is given")

    try:
        text = _read_text(args.input)
    except OSError as error:
        print(f"cannot read input: {error}", file=sys.stderr)
        return 2
    if not text:
        print("input text is empty", file=sys.stderr)
        return 2

    try:
        from kokoro_onnx import Kokoro
        import soundfile

        audio, rate = Kokoro(args.model, args.voices).create(
            text, voice=args.voice, speed=args.speed, lang=args.lang
        )
        if len(audio) == 0:
            # Exiting zero with no audio is precisely the failure that made the
            # previous CLI unusable. Never repeat it.
            print("synthesis produced no audio", file=sys.stderr)
            return 1
        soundfile.write(args.output, audio, rate, subtype="PCM_16")
    except Exception as error:  # noqa: BLE001 - the exit code is the contract
        print(f"synthesis failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
