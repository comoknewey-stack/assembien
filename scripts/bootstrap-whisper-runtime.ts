import {
  bootstrapWhisperRuntime,
  DEFAULT_WHISPER_CPP_ARCHIVE_URL,
  DEFAULT_WHISPER_CPP_MODEL_URL
} from '@assem/config';

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function main(): Promise<void> {
  const result = await bootstrapWhisperRuntime({
    archiveUrl:
      readOptionalEnv('ASSEM_WHISPER_CPP_ARCHIVE_URL') ??
      DEFAULT_WHISPER_CPP_ARCHIVE_URL,
    modelUrl:
      readOptionalEnv('ASSEM_WHISPER_CPP_MODEL_URL') ??
      DEFAULT_WHISPER_CPP_MODEL_URL,
    archivePath: readOptionalEnv('ASSEM_WHISPER_CPP_ARCHIVE_PATH'),
    modelSourcePath: readOptionalEnv('ASSEM_WHISPER_CPP_MODEL_SOURCE_PATH')
  });

  console.log('');
  console.log('Whisper bootstrap completado');
  console.log(`Runtime root: ${result.paths.runtimeRoot}`);
  console.log(`CLI esperado: ${result.paths.cliPath}`);
  console.log(`Modelo esperado: ${result.paths.modelPath}`);
  console.log(`Runtime descargado: ${result.downloadedRuntime ? 'si' : 'no'}`);
  console.log(`Modelo descargado: ${result.downloadedModel ? 'si' : 'no'}`);
  console.log(`Runtime copiado localmente: ${result.copiedRuntimeArchive ? 'si' : 'no'}`);
  console.log(`Modelo copiado localmente: ${result.copiedModel ? 'si' : 'no'}`);
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'El bootstrap de Whisper ha fallado.'
  );
  process.exitCode = 1;
});
