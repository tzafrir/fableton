// SS12 "Export" — the WAV half: 16-bit PCM, interleaved, RIFF/WAVE. Pure
// byte-packing, unit-tested headlessly (SS15); the render half is
// ./renderProject.ts.

export interface WavSource {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

const BYTES_PER_SAMPLE = 2; // 16-bit PCM

/** Float [-1, 1] -> signed 16-bit with symmetric clamp. */
export function floatTo16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

export function encodeWav(source: WavSource): ArrayBuffer {
  const channels = Math.max(1, source.numberOfChannels);
  const frames = source.length;
  const dataBytes = frames * channels * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, source.sampleRate, true);
  view.setUint32(28, source.sampleRate * channels * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, channels * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) channelData.push(source.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      view.setInt16(offset, floatTo16(channelData[ch]?.[i] ?? 0), true);
      offset += BYTES_PER_SAMPLE;
    }
  }
  return buffer;
}
