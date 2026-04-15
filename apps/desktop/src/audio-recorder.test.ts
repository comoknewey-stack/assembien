import { describe, expect, it } from 'vitest';

import { arrayBufferToBase64, downsampleMonoPcm, encodePcm16Wav } from './audio-recorder';

describe('audio-recorder helpers', () => {
  it('downsamples mono PCM data to 16 kHz without changing the waveform order', () => {
    const downsampled = downsampleMonoPcm(
      new Float32Array([0, 1, 0, -1]),
      32_000,
      16_000
    );

    expect(Array.from(downsampled)).toEqual([0.5, -0.5]);
  });

  it('encodes PCM samples as a valid WAV header plus 16-bit data', () => {
    const wavBuffer = encodePcm16Wav(new Float32Array([0, 0.5, -0.5]), 16_000);
    const wavBytes = new Uint8Array(wavBuffer);
    const view = new DataView(wavBuffer);

    expect(String.fromCharCode(...wavBytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wavBytes.slice(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(6);
  });

  it('serializes audio buffers to base64 for the local agent payload', () => {
    const buffer = Uint8Array.from([104, 105]).buffer;

    expect(arrayBufferToBase64(buffer)).toBe('aGk=');
  });
});
