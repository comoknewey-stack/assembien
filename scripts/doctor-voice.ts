import path from 'node:path';

import { createAssemConfig, findAssemRepoRoot } from '@assem/config';

import { WindowsTextToSpeechProvider } from '../apps/local-agent/src/voice/powershell-provider';
import { WhisperCppSpeechToTextProvider } from '../apps/local-agent/src/voice/whispercpp-provider';

async function main(): Promise<void> {
  const repoRoot = findAssemRepoRoot(process.cwd());
  const agentWorkspaceRoot = path.join(repoRoot, 'apps', 'local-agent');
  process.chdir(agentWorkspaceRoot);

  const config = createAssemConfig();
  const settings = {
    sttProviderId: config.voiceSttProviderId,
    ttsProviderId: config.voiceTtsProviderId,
    preferredLanguage: config.voiceLanguage,
    autoReadResponses: config.voiceAutoReadResponses,
    voiceModeEnabled: config.voiceModeEnabledByDefault,
    micMuted: false,
    wakeWordEnabled: config.wakeWordEnabled,
    wakeWord: config.wakeWord,
    wakeWordAliases: config.wakeWordAliases,
    wakeWindowMs: config.wakeWindowMs,
    wakeIntervalMs: config.wakeIntervalMs,
    activeSilenceMs: config.activeSilenceMs,
    activeMaxMs: config.activeMaxMs,
    activeMinSpeechMs: config.activeMinSpeechMs,
    activePrerollMs: config.activePrerollMs,
    activePostrollMs: config.activePostrollMs,
    wakeDebug: config.wakeDebug
  };
  const sttProvider = new WhisperCppSpeechToTextProvider({
    cliPath: config.whisperCppCliPath,
    modelPath: config.whisperCppModelPath,
    threads: config.whisperCppThreads,
    initialPrompt: config.whisperCppInitialPrompt,
    beamSize: config.whisperCppBeamSize,
    tempRoot: path.join(config.dataRoot, 'voice-temp')
  });
  const ttsProvider = new WindowsTextToSpeechProvider();

  await sttProvider.initialize();
  await ttsProvider.initialize?.();

  const [sttHealth, ttsHealth] = await Promise.all([
    sttProvider.healthCheck(settings),
    ttsProvider.healthCheck(settings)
  ]);

  console.log('ASSEM Voice Doctor');
  console.log(`STT activo: ${settings.sttProviderId}`);
  console.log(`TTS activo: ${settings.ttsProviderId}`);
  console.log(`Idioma: ${settings.preferredLanguage}`);
  console.log(`CLI Whisper: ${config.whisperCppCliPath ?? 'sin ruta'}`);
  console.log(`Modelo Whisper: ${config.whisperCppModelPath ?? 'sin ruta'}`);
  console.log(`Threads Whisper: ${config.whisperCppThreads}`);
  console.log(`Beam size Whisper: ${config.whisperCppBeamSize ?? 'por defecto'}`);
  console.log(
    `Prompt inicial Whisper: ${config.whisperCppInitialPrompt ? 'activo' : 'sin prompt'}`
  );
  console.log(`Temp voice root: ${path.join(config.dataRoot, 'voice-temp')}`);
  console.log(`Modo conversacion por defecto: ${settings.voiceModeEnabled ? 'activo' : 'apagado'}`);
  console.log(`Wake word experimental: ${settings.wakeWordEnabled ? settings.wakeWord : 'desactivada'}`);
  console.log(`STT legado de Windows: aislado / no activo en runtime`);
  console.log(`Estado STT: ${sttHealth.status} / ${sttHealth.available ? 'listo' : 'no listo'}`);
  if (sttHealth.error) {
    console.log(`Detalle STT: ${sttHealth.error}`);
  }
  console.log(`Estado TTS: ${ttsHealth.status} / ${ttsHealth.available ? 'listo' : 'no listo'}`);
  if (ttsHealth.error) {
    console.log(`Detalle TTS: ${ttsHealth.error}`);
  }

  if (!sttHealth.available || !ttsHealth.available) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Voice doctor failed.');
  process.exitCode = 1;
});
