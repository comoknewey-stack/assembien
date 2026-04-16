import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bootstrapWhisperRuntime,
  DEFAULT_WHISPER_CPP_MODEL_RELATIVE_PATH,
  DEFAULT_WHISPER_CPP_RUNTIME_DIRECTORY,
  resolveWhisperRuntimePaths
} from './whisper-runtime';

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await fs.rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

describe('resolveWhisperRuntimePaths', () => {
  it('discovers the standard .assem-runtime layout from a nested workspace', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-paths-'));
    cleanupPaths.push(repoRoot);
    await fs.mkdir(path.join(repoRoot, 'apps', 'local-agent'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'assem',
          workspaces: ['apps/*', 'packages/*']
        },
        null,
        2
      ),
      'utf8'
    );

    const paths = resolveWhisperRuntimePaths({
      cwd: path.join(repoRoot, 'apps', 'local-agent')
    });

    expect(paths.repoRoot).toBe(repoRoot);
    expect(paths.runtimeRoot).toBe(
      path.join(repoRoot, DEFAULT_WHISPER_CPP_RUNTIME_DIRECTORY)
    );
    expect(paths.cliPath).toMatch(/\.assem-runtime[\\/]whispercpp[\\/]bin[\\/]Release[\\/]whisper-cli\.exe$/);
    expect(paths.modelPath).toBe(
      path.join(repoRoot, DEFAULT_WHISPER_CPP_RUNTIME_DIRECTORY, DEFAULT_WHISPER_CPP_MODEL_RELATIVE_PATH)
    );
  });
});

describe('bootstrapWhisperRuntime', () => {
  it('is idempotent and only downloads missing runtime pieces once', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-bootstrap-'));
    cleanupPaths.push(repoRoot);
    const calls: string[] = [];

    const first = await bootstrapWhisperRuntime({
      repoRoot,
      logger: {
        info() {
          return;
        }
      },
      dependencies: {
        downloadFile: async (_sourceUrl, targetPath) => {
          calls.push(`download:${path.basename(targetPath)}`);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, 'payload', 'utf8');
        },
        extractZip: async (_archivePath, destinationPath) => {
          calls.push('extract');
          const cliPath = path.join(destinationPath, 'bin', 'Release', 'whisper-cli.exe');
          await fs.mkdir(path.dirname(cliPath), { recursive: true });
          await fs.writeFile(cliPath, 'fake whisper cli', 'utf8');
        }
      }
    });

    expect(first.status.ready).toBe(true);
    expect(first.downloadedRuntime).toBe(true);
    expect(first.downloadedModel).toBe(true);
    expect(calls).toEqual([
      'download:whisper-bin-x64.zip',
      'extract',
      'download:ggml-base.bin'
    ]);

    const second = await bootstrapWhisperRuntime({
      repoRoot,
      logger: {
        info() {
          return;
        }
      },
      dependencies: {
        downloadFile: async () => {
          calls.push('unexpected-download');
        },
        extractZip: async () => {
          calls.push('unexpected-extract');
        }
      }
    });

    expect(second.status.ready).toBe(true);
    expect(second.downloadedRuntime).toBe(false);
    expect(second.downloadedModel).toBe(false);
    expect(calls).not.toContain('unexpected-download');
    expect(calls).not.toContain('unexpected-extract');
  });
});
