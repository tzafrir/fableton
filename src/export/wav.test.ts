// SS12 WAV encoding, byte-level (SS15).

import { describe, expect, it } from "vitest";
import { encodeWav, floatTo16, type WavSource } from "./wav";

function source(channels: Float32Array[], sampleRate = 44100): WavSource {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    getChannelData: (ch) => channels[ch] as Float32Array,
  };
}

describe("floatTo16", () => {
  it("maps the rails exactly and clamps beyond them", () => {
    expect(floatTo16(0)).toBe(0);
    expect(floatTo16(1)).toBe(0x7fff);
    expect(floatTo16(-1)).toBe(-0x8000);
    expect(floatTo16(2)).toBe(0x7fff);
    expect(floatTo16(-2)).toBe(-0x8000);
  });
});

describe("encodeWav", () => {
  it("writes a valid RIFF/WAVE header with the right sizes", () => {
    const wav = encodeWav(source([new Float32Array(100), new Float32Array(100)], 48000));
    const view = new DataView(wav);
    const ascii = (offset: number, n: number): string =>
      Array.from({ length: n }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join("");
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(40, true)).toBe(100 * 2 * 2); // data bytes
    expect(wav.byteLength).toBe(44 + 400);
  });

  it("interleaves L/R frames", () => {
    const left = new Float32Array([1, 0]);
    const right = new Float32Array([-1, 0.5]);
    const wav = encodeWav(source([left, right]));
    const view = new DataView(wav);
    expect(view.getInt16(44, true)).toBe(0x7fff); // L0
    expect(view.getInt16(46, true)).toBe(-0x8000); // R0
    expect(view.getInt16(48, true)).toBe(0); // L1
    expect(view.getInt16(50, true)).toBe(floatTo16(0.5)); // R1
  });
});
