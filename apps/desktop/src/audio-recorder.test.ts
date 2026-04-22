import { describe, expect, it } from 'vitest';

import { analyzeMonoPcmCapture, normalizeMonoPcmLevel } from './audio-recorder';

describe('analyzeMonoPcmCapture', () => {
  it('flags empty audio as suspicious', () => {
    const diagnostics = analyzeMonoPcmCapture(new Float32Array(), 16_000, 48_000);

    expect(diagnostics.byteLength).toBe(44);
    expect(diagnostics.captureSampleRateHz).toBe(48_000);
    expect(diagnostics.sampleRateHz).toBe(16_000);
    expect(diagnostics.approximateDurationMs).toBe(0);
    expect(diagnostics.silenceDetected).toBe(true);
    expect(diagnostics.suspicious).toBe(true);
  });

  it('flags almost silent audio as suspicious', () => {
    const samples = new Float32Array(16_000).fill(0.0005);
    const diagnostics = analyzeMonoPcmCapture(samples, 16_000, 48_000);

    expect(diagnostics.approximateDurationMs).toBe(1_000);
    expect(diagnostics.silenceDetected).toBe(true);
    expect(diagnostics.suspicious).toBe(true);
  });

  it('keeps valid speech-like audio within expected WAV parameters', () => {
    const samples = new Float32Array(16_000);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin((index / 16_000) * Math.PI * 2 * 220) * 0.45;
    }

    const diagnostics = analyzeMonoPcmCapture(samples, 16_000, 44_100);

    expect(diagnostics.byteLength).toBe(44 + samples.length * 2);
    expect(diagnostics.channelCount).toBe(1);
    expect(diagnostics.bitDepth).toBe(16);
    expect(diagnostics.approximateDurationMs).toBe(1_000);
    expect(diagnostics.peakLevel).toBeGreaterThan(0.4);
    expect(diagnostics.silenceDetected).toBe(false);
    expect(diagnostics.suspicious).toBe(false);
  });

  it('raises quiet but usable speech before WAV encoding', () => {
    const samples = new Float32Array(16_000);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin((index / 16_000) * Math.PI * 2 * 220) * 0.08;
    }

    const normalized = normalizeMonoPcmLevel(samples);
    const diagnostics = analyzeMonoPcmCapture(
      normalized.samples,
      16_000,
      48_000,
      normalized.gainApplied
    );

    expect(normalized.gainApplied).toBeGreaterThan(1);
    expect(diagnostics.gainApplied).toBeGreaterThan(1);
    expect(diagnostics.peakLevel).toBeGreaterThan(0.3);
    expect(diagnostics.silenceDetected).toBe(false);
  });
});
