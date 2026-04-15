import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  LocalDirectoryEntry,
  LocalDirectoryListInput,
  LocalDirectoryListOutput,
  LocalFileInput,
  LocalFileOutput,
  LocalFileReadInput,
  LocalFileReadOutput,
  ToolDefinition
} from '@assem/shared-types';

const MAX_TEXT_READ_BYTES = 8_192;

function sanitizeRelativePath(value: string | undefined, allowEmpty = false): string {
  const normalized = (value ?? '').trim().replace(/\\/g, '/');

  if (!normalized) {
    if (allowEmpty) {
      return '';
    }

    throw new Error('Se requiere una ruta relativa del sandbox.');
  }

  if (normalized.includes('\0')) {
    throw new Error('Las rutas del sandbox no pueden contener bytes nulos.');
  }

  if (path.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) {
    throw new Error('Las rutas del sandbox deben ser relativas.');
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new Error('No se permite path traversal.');
  }

  return segments.join(path.sep);
}

function looksLikeText(buffer: Buffer): boolean {
  return !buffer.includes(0);
}

export function ensureInsideSandbox(
  sandboxRoot: string,
  relativePath = ''
): string {
  const normalizedRoot = path.resolve(sandboxRoot);
  const safeRelativePath = sanitizeRelativePath(relativePath, true);
  const candidate = path.resolve(normalizedRoot, safeRelativePath);

  const rootLower = normalizedRoot.toLowerCase();
  const candidateLower = candidate.toLowerCase();
  const rootWithSeparator = rootLower.endsWith(path.sep.toLowerCase())
    ? rootLower
    : `${rootLower}${path.sep.toLowerCase()}`;

  if (candidateLower !== rootLower && !candidateLower.startsWith(rootWithSeparator)) {
    throw new Error('La ruta solicitada esta fuera de la raiz permitida del sandbox.');
  }

  return candidate;
}

export interface SandboxEntryProbe {
  absolutePath: string;
  exists: boolean;
  kind?: 'file' | 'directory';
}

export async function probeSandboxEntry(
  sandboxRoot: string,
  relativePath: string
): Promise<SandboxEntryProbe> {
  const absolutePath = ensureInsideSandbox(sandboxRoot, relativePath);
  const stats = await fs.stat(absolutePath).catch(() => null);

  return {
    absolutePath,
    exists: stats !== null,
    kind: stats?.isDirectory() ? 'directory' : stats?.isFile() ? 'file' : undefined
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listEntries(
  absolutePath: string,
  baseRelativePath: string
): Promise<LocalDirectoryEntry[]> {
  if (!(await fileExists(absolutePath))) {
    return [];
  }

  const entries = await fs.readdir(absolutePath, { withFileTypes: true });

  return entries
    .map((entry) => {
      const relativePath = [baseRelativePath, entry.name]
        .filter(Boolean)
        .join('/')
        .replace(/\\/g, '/');

      return {
        name: entry.name,
        kind: entry.isDirectory() ? 'directory' : 'file',
        relativePath
      } satisfies LocalDirectoryEntry;
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function createLocalFilesTools(): [
  ToolDefinition<LocalDirectoryListInput, LocalDirectoryListOutput>,
  ToolDefinition<LocalFileReadInput, LocalFileReadOutput>,
  ToolDefinition<LocalFileInput, LocalFileOutput>
] {
  const listDirectoryTool: ToolDefinition<
    LocalDirectoryListInput,
    LocalDirectoryListOutput
  > = {
    id: 'local-files.list-directory',
    label: 'List sandbox directory',
    description:
      'Lists files and folders inside the configured sandbox root.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['read_only'],
    async execute(input, context) {
      const relativePath = sanitizeRelativePath(input.relativePath, true);
      const absolutePath = ensureInsideSandbox(context.sandboxRoot, relativePath);
      const entries = await listEntries(absolutePath, relativePath.replace(/\\/g, '/'));

      return {
        summary:
          entries.length === 0
            ? `The sandbox directory ${absolutePath} is empty.`
            : `Found ${entries.length} item(s) in ${absolutePath}.`,
        output: {
          absolutePath,
          entries
        }
      };
    }
  };

  const readFileTool: ToolDefinition<LocalFileReadInput, LocalFileReadOutput> = {
    id: 'local-files.read-file',
    label: 'Read sandbox file',
    description: 'Reads a text file from inside the sandbox root.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['read_only'],
    async execute(input, context) {
      const relativePath = sanitizeRelativePath(input.relativePath);
      const absolutePath = ensureInsideSandbox(context.sandboxRoot, relativePath);
      const stats = await fs.stat(absolutePath).catch(() => null);

      if (!stats || !stats.isFile()) {
        throw new Error('El archivo solicitado del sandbox no existe.');
      }

      const bytesToRead = Math.min(stats.size, MAX_TEXT_READ_BYTES);
      const fileHandle = await fs.open(absolutePath, 'r');

      let buffer: Buffer;
      try {
        buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0);
        buffer = buffer.subarray(0, bytesRead);
      } finally {
        await fileHandle.close();
      }

      const isText = looksLikeText(buffer);
      const truncated = stats.size > MAX_TEXT_READ_BYTES;
      const contents = isText ? buffer.toString('utf8') : '';

      return {
        summary: isText
          ? truncated
            ? `Read the first ${contents.length} character(s) from ${relativePath.replace(/\\/g, '/')} in the sandbox.`
            : `Read ${relativePath.replace(/\\/g, '/')} from the sandbox.`
          : `The sandbox file ${relativePath.replace(/\\/g, '/')} does not look like text.`,
        output: {
          absolutePath,
          contents,
          isText,
          truncated,
          totalBytes: stats.size
        }
      };
    }
  };

  const createEntryTool: ToolDefinition<LocalFileInput, LocalFileOutput> = {
    id: 'local-files.create-entry',
    label: 'Create local file or folder',
    description: 'Creates a file or directory inside the configured sandbox root.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    requiresPermissions: ['write_safe'],
    async execute(input, context) {
      const relativePath = sanitizeRelativePath(input.relativePath);
      const absolutePath = ensureInsideSandbox(context.sandboxRoot, relativePath);

      if (await fileExists(absolutePath)) {
        throw new Error('La ruta solicitada del sandbox ya existe.');
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });

      if (input.kind === 'directory') {
        await fs.mkdir(absolutePath, { recursive: false });
      } else {
        const contents =
          input.fileContents ??
          `Created by ASSEM on ${context.now.toISOString()}\n`;
        await fs.writeFile(absolutePath, contents, 'utf8');
      }

      return {
        summary: `Created the ${input.kind} at ${absolutePath}.`,
        output: {
          kind: input.kind,
          absolutePath,
          simulated: false
        }
      };
    }
  };

  return [listDirectoryTool, readFileTool, createEntryTool];
}

export function createLocalFilesTool(): ToolDefinition<LocalFileInput, LocalFileOutput> {
  return createLocalFilesTools()[2];
}
