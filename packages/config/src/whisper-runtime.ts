import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const DEFAULT_WHISPER_CPP_VERSION = 'v1.8.4';
export const DEFAULT_WHISPER_CPP_ARCHIVE_NAME = 'whisper-bin-x64.zip';
export const DEFAULT_WHISPER_CPP_MODEL_NAME = 'ggml-base.bin';
export const DEFAULT_WHISPER_CPP_RUNTIME_DIRECTORY = path.join(
  '.assem-runtime',
  'whispercpp'
);
export const DEFAULT_WHISPER_CPP_CLI_RELATIVE_PATH = path.join(
  'bin',
  'Release',
  'whisper-cli.exe'
);
export const DEFAULT_WHISPER_CPP_MODEL_RELATIVE_PATH = path.join(
  'models',
  DEFAULT_WHISPER_CPP_MODEL_NAME
);
export const DEFAULT_WHISPER_CPP_ARCHIVE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${DEFAULT_WHISPER_CPP_VERSION}/${DEFAULT_WHISPER_CPP_ARCHIVE_NAME}`;
export const DEFAULT_WHISPER_CPP_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_WHISPER_CPP_MODEL_NAME}`;

export interface WhisperRuntimePaths {
  repoRoot: string;
  runtimeRoot: string;
  cliPath: string;
  modelPath: string;
}

export interface WhisperRuntimeStatus extends WhisperRuntimePaths {
  cliExists: boolean;
  modelExists: boolean;
  ready: boolean;
}

export interface WhisperBootstrapLogger {
  info(message: string): void;
}

export interface WhisperBootstrapDependencies {
  createDirectory(directoryPath: string): Promise<void>;
  fileExists(filePath: string): Promise<boolean>;
  copyFile(sourcePath: string, targetPath: string): Promise<void>;
  downloadFile(sourceUrl: string, targetPath: string): Promise<void>;
  extractZip(archivePath: string, destinationPath: string): Promise<void>;
  removePath(targetPath: string): Promise<void>;
  createTempDirectory(prefix: string): Promise<string>;
}

export interface WhisperBootstrapOptions {
  cwd?: string;
  repoRoot?: string;
  runtimeRoot?: string;
  cliPath?: string;
  modelPath?: string;
  archiveUrl?: string;
  modelUrl?: string;
  archivePath?: string;
  modelSourcePath?: string;
  logger?: WhisperBootstrapLogger;
  dependencies?: Partial<WhisperBootstrapDependencies>;
}

export interface WhisperBootstrapResult {
  paths: WhisperRuntimePaths;
  status: WhisperRuntimeStatus;
  downloadedRuntime: boolean;
  downloadedModel: boolean;
  copiedRuntimeArchive: boolean;
  copiedModel: boolean;
}

function defaultLogger(): WhisperBootstrapLogger {
  return {
    info(message: string) {
      console.log(message);
    }
  };
}

function resolvePath(fromRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(fromRoot, value);
}

function readPackageName(packageJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: string; workspaces?: unknown };
    if (parsed.name === 'assem') {
      return parsed.name;
    }

    if (Array.isArray(parsed.workspaces)) {
      return 'assem';
    }

    return null;
  } catch {
    return null;
  }
}

export function findAssemRepoRoot(cwd = process.cwd()): string {
  let current = path.resolve(cwd);

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath) && readPackageName(packageJsonPath) === 'assem') {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd);
    }

    current = parent;
  }
}

export function resolveWhisperRuntimePaths(
  options: {
    cwd?: string;
    repoRoot?: string;
    runtimeRoot?: string;
    cliPath?: string;
    modelPath?: string;
  } = {}
): WhisperRuntimePaths {
  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : findAssemRepoRoot(options.cwd);
  const runtimeRoot = options.runtimeRoot
    ? resolvePath(repoRoot, options.runtimeRoot)
    : path.join(repoRoot, DEFAULT_WHISPER_CPP_RUNTIME_DIRECTORY);
  const cliPath = options.cliPath
    ? resolvePath(repoRoot, options.cliPath)
    : path.join(runtimeRoot, DEFAULT_WHISPER_CPP_CLI_RELATIVE_PATH);
  const modelPath = options.modelPath
    ? resolvePath(repoRoot, options.modelPath)
    : path.join(runtimeRoot, DEFAULT_WHISPER_CPP_MODEL_RELATIVE_PATH);

  return {
    repoRoot,
    runtimeRoot,
    cliPath,
    modelPath
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function inspectWhisperRuntime(
  paths: WhisperRuntimePaths
): Promise<WhisperRuntimeStatus> {
  const cliExists = await fileExists(paths.cliPath);
  const modelExists = await fileExists(paths.modelPath);

  return {
    ...paths,
    cliExists,
    modelExists,
    ready: cliExists && modelExists
  };
}

function escapePowerShellLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function downloadFile(sourceUrl: string, targetPath: string): Promise<void> {
  const response = await fetch(sourceUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'ASSEM bootstrap'
    }
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `No se ha podido descargar ${sourceUrl} (${response.status} ${response.statusText}).`
    );
  }

  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  const output = fs.createWriteStream(targetPath);
  await pipeline(Readable.fromWeb(response.body), output);
}

async function extractZip(archivePath: string, destinationPath: string): Promise<void> {
  await fsPromises.mkdir(destinationPath, { recursive: true });

  if (process.platform !== 'win32') {
    throw new Error(
      'El bootstrap automatico de whisper.cpp de ASSEM esta preparado para Windows en esta fase.'
    );
  }

  const script = `Expand-Archive -LiteralPath '${escapePowerShellLiteral(
    archivePath
  )}' -DestinationPath '${escapePowerShellLiteral(destinationPath)}' -Force`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script
      ],
      {
        stdio: 'pipe',
        windowsHide: true
      }
    );
    const stderr: string[] = [];

    child.stderr.on('data', (chunk) => {
      stderr.push(chunk.toString('utf8'));
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          stderr.join(' ').trim() ||
            'No se ha podido extraer el runtime de whisper.cpp.'
        )
      );
    });
  });
}

function createDefaultBootstrapDependencies(): WhisperBootstrapDependencies {
  return {
    createDirectory: async (directoryPath) => {
      await fsPromises.mkdir(directoryPath, { recursive: true });
    },
    fileExists,
    copyFile: async (sourcePath, targetPath) => {
      await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
      await fsPromises.copyFile(sourcePath, targetPath);
    },
    downloadFile,
    extractZip,
    removePath: async (targetPath) => {
      await fsPromises.rm(targetPath, { recursive: true, force: true });
    },
    createTempDirectory: async (prefix) => {
      return await fsPromises.mkdtemp(prefix);
    }
  };
}

export async function bootstrapWhisperRuntime(
  options: WhisperBootstrapOptions = {}
): Promise<WhisperBootstrapResult> {
  const logger = options.logger ?? defaultLogger();
  const dependencies = {
    ...createDefaultBootstrapDependencies(),
    ...options.dependencies
  };
  const paths = resolveWhisperRuntimePaths(options);
  const archiveUrl = options.archiveUrl ?? DEFAULT_WHISPER_CPP_ARCHIVE_URL;
  const modelUrl = options.modelUrl ?? DEFAULT_WHISPER_CPP_MODEL_URL;

  await dependencies.createDirectory(paths.runtimeRoot);
  await dependencies.createDirectory(path.dirname(paths.cliPath));
  await dependencies.createDirectory(path.dirname(paths.modelPath));

  const initialStatus = await inspectWhisperRuntime(paths);
  if (initialStatus.ready) {
    logger.info(`Whisper runtime listo en ${paths.runtimeRoot}`);
    return {
      paths,
      status: initialStatus,
      downloadedRuntime: false,
      downloadedModel: false,
      copiedRuntimeArchive: false,
      copiedModel: false
    };
  }

  const tempRoot = await dependencies.createTempDirectory(
    path.join(paths.repoRoot, '.assem-runtime-bootstrap-')
  );
  let downloadedRuntime = false;
  let downloadedModel = false;
  let copiedRuntimeArchive = false;
  let copiedModel = false;

  try {
    if (!initialStatus.cliExists) {
      const archiveTargetPath = path.join(tempRoot, DEFAULT_WHISPER_CPP_ARCHIVE_NAME);

      if (options.archivePath) {
        logger.info(`Copiando runtime de whisper.cpp desde ${options.archivePath}`);
        await dependencies.copyFile(options.archivePath, archiveTargetPath);
        copiedRuntimeArchive = true;
      } else {
        logger.info(`Descargando runtime de whisper.cpp desde ${archiveUrl}`);
        await dependencies.downloadFile(archiveUrl, archiveTargetPath);
        downloadedRuntime = true;
      }

      logger.info(`Extrayendo runtime de whisper.cpp en ${paths.runtimeRoot}`);
      await dependencies.extractZip(archiveTargetPath, paths.runtimeRoot);
    }

    if (!initialStatus.modelExists) {
      if (options.modelSourcePath) {
        logger.info(`Copiando modelo Whisper desde ${options.modelSourcePath}`);
        await dependencies.copyFile(options.modelSourcePath, paths.modelPath);
        copiedModel = true;
      } else {
        logger.info(`Descargando modelo Whisper desde ${modelUrl}`);
        await dependencies.downloadFile(modelUrl, paths.modelPath);
        downloadedModel = true;
      }
    }

    const finalStatus = await inspectWhisperRuntime(paths);
    if (!finalStatus.ready) {
      const missing: string[] = [];
      if (!finalStatus.cliExists) {
        missing.push(`binario: ${finalStatus.cliPath}`);
      }
      if (!finalStatus.modelExists) {
        missing.push(`modelo: ${finalStatus.modelPath}`);
      }

      throw new Error(
        `El bootstrap de Whisper no ha dejado el runtime listo. Falta ${missing.join(
          ' y '
        )}.`
      );
    }

    logger.info(`Whisper runtime preparado correctamente en ${paths.runtimeRoot}`);
    return {
      paths,
      status: finalStatus,
      downloadedRuntime,
      downloadedModel,
      copiedRuntimeArchive,
      copiedModel
    };
  } finally {
    await dependencies.removePath(tempRoot).catch(() => undefined);
  }
}
