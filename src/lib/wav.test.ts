import { describe, expect, it } from "vitest";
import { pcm16DurationSeconds, wavFromPcm16, WHISPER_SAMPLE_RATE } from "./wav";

/** Read the header back the way a decoder would, rather than trusting offsets. */
function parse(wav: ArrayBuffer) {
  const view = new DataView(wav);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...new Uint8Array(wav, offset, length));
  return {
    riff: ascii(0, 4),
    riffSize: view.getUint32(4, true),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true),
    samples: new Uint8Array(wav, 44),
  };
}

const pcm = (...bytes: number[]) => new Uint8Array(bytes).buffer;

describe("wavFromPcm16", () => {
  it("writes a header whisper.cpp can read: mono, 16-bit, PCM", () => {
    const header = parse(wavFromPcm16([pcm(1, 0, 2, 0)], WHISPER_SAMPLE_RATE));
    expect(header.riff).toBe("RIFF");
    expect(header.wave).toBe("WAVE");
    expect(header.fmt).toBe("fmt ");
    expect(header.data).toBe("data");
    expect(header.fmtSize).toBe(16);
    expect(header.format).toBe(1);
    expect(header.channels).toBe(1);
    expect(header.bitsPerSample).toBe(16);
    expect(header.sampleRate).toBe(16_000);
  });

  it("declares sizes that agree with the bytes actually present", () => {
    const wav = wavFromPcm16([pcm(1, 0, 2, 0), pcm(3, 0)], 16_000);
    const header = parse(wav);
    // A header that disagrees with its contents does not fail loudly; it
    // decodes as truncated audio or trailing noise.
    expect(header.dataSize).toBe(6);
    expect(wav.byteLength).toBe(44 + 6);
    expect(header.riffSize).toBe(wav.byteLength - 8);
  });

  it("derives byte rate and block align from the format, not from constants", () => {
    const header = parse(wavFromPcm16([pcm(0, 0)], 8_000));
    expect(header.blockAlign).toBe(2); // 1 channel x 2 bytes
    expect(header.byteRate).toBe(16_000); // 8000 Hz x 2 bytes
  });

  it("concatenates frames in the order they were captured", () => {
    const header = parse(wavFromPcm16([pcm(1, 2), pcm(3, 4), pcm(5, 6)], 16_000));
    expect([...header.samples]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("produces a valid empty recording rather than a malformed one", () => {
    const wav = wavFromPcm16([], 16_000);
    const header = parse(wav);
    expect(wav.byteLength).toBe(44);
    expect(header.dataSize).toBe(0);
    expect(header.riffSize).toBe(36);
  });

  it("drops a stray odd byte instead of describing half a sample", () => {
    const wav = wavFromPcm16([pcm(1, 2, 3)], 16_000);
    const header = parse(wav);
    expect(header.dataSize).toBe(2);
    expect([...header.samples]).toEqual([1, 2]);
    expect(wav.byteLength).toBe(46);
  });

  it("rejects a sample rate that cannot describe audio", () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => wavFromPcm16([pcm(0, 0)], rate), String(rate)).toThrow(RangeError);
    }
  });

  it("rounds a fractional device rate to a whole number of hertz", () => {
    // AudioContext.sampleRate is a double and some devices report a fraction.
    // The header field is an integer, so it has to be decided here rather than
    // truncated silently by the DataView write.
    expect(parse(wavFromPcm16([pcm(0, 0)], 44_100.5)).sampleRate).toBe(44_101);
  });
});

describe("pcm16DurationSeconds", () => {
  it("reports duration from byte count and rate", () => {
    expect(pcm16DurationSeconds(32_000, 16_000)).toBe(1);
    expect(pcm16DurationSeconds(16_000, 16_000)).toBe(0.5);
  });

  it("is zero for an unusable rate rather than infinite", () => {
    expect(pcm16DurationSeconds(32_000, 0)).toBe(0);
  });
});
