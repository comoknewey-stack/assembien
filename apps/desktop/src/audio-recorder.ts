import type { SpeechToTextAudioInput } from '@assem/shared-types';

const TARGET_SAMPLE_RATE_HZ = 16_000;

interface ActiveBrowserRecording {
  stream: MediaStream;
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  startedAt: number;
}

function concatenateFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

export function downsampleMonoPcm(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate = TARGET_SAMPLE_RATE_HZ
): Float32Array {
  if (inputSampleRate === targetSampleRate) {
    return input;
  }

  if (targetSampleRate > inputSampleRate) {
    throw new Error('No se puede sobremuestrear el audio del microfono en esta fase.');
  }

  const ratio = inputSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  let outputIndex = 0;
  let inputIndex = 0;

  while (outputIndex < outputLength) {
    const nextInputIndex = Math.round((outputIndex + 1) * ratio);
    let total = 0;
    let count = 0;

    for (let index = inputIndex; index < nextInputIndex && index < input.length; index += 1) {
      total += input[index] ?? 0;
      count += 1;
    }

    output[outputIndex] = count > 0 ? total / count : 0;
    outputIndex += 1;
    inputIndex = nextInputIndex;
  }

  return output;
}

export function encodePcm16Wav(
  samples: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE_HZ
): ArrayBuffer {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  function writeAscii(offset: number, value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export class BrowserVoiceRecorder {
  private activeRecording: ActiveBrowserRecording | null = null;

  async start(): Promise<void> {
    if (this.activeRecording) {
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      throw new Error('El microfono no esta disponible en este entorno desktop.');
    }

    const stream = await mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    const audioContext = new AudioContext();
    await audioContext.resume();

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];

    processor.onaudioprocess = (event) => {
      const inputChannel = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(inputChannel));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    this.activeRecording = {
      stream,
      audioContext,
      source,
      processor,
      chunks,
      startedAt: Date.now()
    };
  }

  async stop(): Promise<SpeechToTextAudioInput> {
    if (!this.activeRecording) {
      throw new Error('No hay una grabacion local activa para enviar.');
    }

    const activeRecording = this.activeRecording;
    this.activeRecording = null;

    try {
      const pcm = concatenateFloat32Chunks(activeRecording.chunks);
      const downsampled = downsampleMonoPcm(
        pcm,
        activeRecording.audioContext.sampleRate,
        TARGET_SAMPLE_RATE_HZ
      );
      const wavBuffer = encodePcm16Wav(downsampled, TARGET_SAMPLE_RATE_HZ);

      return {
        mimeType: 'audio/wav',
        fileName: 'assem-recording.wav',
        base64Data: arrayBufferToBase64(wavBuffer),
        durationMs: Date.now() - activeRecording.startedAt
      };
    } finally {
      await this.disposeActiveRecording(activeRecording);
    }
  }

  async cancel(): Promise<void> {
    if (!this.activeRecording) {
      return;
    }

    const activeRecording = this.activeRecording;
    this.activeRecording = null;
    await this.disposeActiveRecording(activeRecording);
  }

  private async disposeActiveRecording(recording: ActiveBrowserRecording): Promise<void> {
    recording.processor.onaudioprocess = null;
    recording.source.disconnect();
    recording.processor.disconnect();
    recording.stream.getTracks().forEach((track) => track.stop());
    await recording.audioContext.close().catch(() => undefined);
  }
}
