// Framing captured microphone audio as a WAV file.
//
// whisper.cpp reads audio from a file, and Dani's local transcription endpoint
// accepts `audio/wav` only, so the renderer has to produce a real RIFF/WAVE
// container rather than raw samples. The container is 44 bytes of header in
// front of the PCM it already has, which is worth doing exactly right: a
// malformed header does not fail loudly, it transcribes silence or noise.
//
// Mono 16-bit PCM is the only shape emitted here because it is the only shape
// whisper.cpp wants. Anything else would be converted on the way in anyway,
// and offering options that the one consumer cannot use is how a helper grows
// paths nobody tests.

/** whisper.cpp resamples internally, but feeding it 16 kHz avoids the work and
 * matches the rate its models were trained on. */
export const WHISPER_SAMPLE_RATE = 16_000;

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const PCM_FORMAT = 1;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/**
 * Wrap little-endian 16-bit mono PCM in a WAV container.
 *
 * `chunks` are concatenated in order, which is how the capture path collects
 * them: one buffer per audio frame, appended as they arrive.
 *
 * Throws on a sample rate that cannot describe real audio. A zero or negative
 * rate would produce a header a decoder either rejects or, worse, interprets
 * as a division by zero somewhere downstream.
 */
export function wavFromPcm16(chunks: readonly ArrayBuffer[], sampleRate: number): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sample rate must be a positive number, received ${sampleRate}`);
  }
  const rate = Math.round(sampleRate);

  let dataBytes = 0;
  for (const chunk of chunks) dataBytes += chunk.byteLength;
  // An odd byte count cannot be whole 16-bit samples. Truncating the stray byte
  // beats emitting a header whose length disagrees with its contents.
  dataBytes -= dataBytes % 2;

  const out = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(out);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

  writeAscii(view, 0, "RIFF");
  // Everything after this field: the 4-byte "WAVE" tag, the 24-byte fmt chunk,
  // and the 8-byte data chunk header, plus the samples themselves.
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunks are 16 bytes
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  const samples = new Uint8Array(out, HEADER_BYTES);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= dataBytes) break;
    const take = Math.min(chunk.byteLength, dataBytes - offset);
    samples.set(new Uint8Array(chunk, 0, take), offset);
    offset += take;
  }
  return out;
}

/** Seconds of audio in a PCM16 byte count, for duration checks. */
export function pcm16DurationSeconds(byteLength: number, sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  return Math.floor(byteLength / 2) / sampleRate;
}
