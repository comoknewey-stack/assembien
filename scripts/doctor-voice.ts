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
    autoReadResponses: config.voiceAutoReadResponses
  };
  const sttProvider = new WhisperCppSpeechToTextProvider({
    cliPath: config.whisperCppCliPath,
    modelPath: config.whisperCppModelPath,
    threads: config.whisperCppThreads,
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
  console.log(`Temp voice root: ${path.join(config.dataRoot, 'voice-temp')}`);
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
