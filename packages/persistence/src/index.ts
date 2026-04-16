import fs from 'node:fs/promises';
import path from 'node:path';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const FILE_REPLACE_RETRY_DELAYS_MS = [20, 50, 100, 200];
const STALE_TMP_FILE_MAX_AGE_MS = 15 * 60 * 1000;

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function isRetryableFileReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function replaceFileWithRetries(
  temporaryPath: string,
  filePath: string
): Promise<void> {
  let lastError: unknown;

  for (const delayMs of [0, ...FILE_REPLACE_RETRY_DELAYS_MS]) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      await fs.rename(temporaryPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableFileReplaceError(error)) {
        throw error;
      }
    }
  }

  for (const delayMs of [0, ...FILE_REPLACE_RETRY_DELAYS_MS]) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      await fs.copyFile(temporaryPath, filePath);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableFileReplaceError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

function isSiblingTemporaryFile(fileName: string, baseFileName: string): boolean {
  return fileName.startsWith(`${baseFileName}.`) && fileName.endsWith('.tmp');
}

export async function cleanupStaleJsonTempFiles(
  filePath: string,
  maxAgeMs = STALE_TMP_FILE_MAX_AGE_MS
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  const baseFileName = path.basename(filePath);

  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const now = Date.now();

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !isSiblingTemporaryFile(entry.name, baseFileName)) {
          return;
        }

        const entryPath = path.join(directoryPath, entry.name);
        try {
          const stats = await fs.stat(entryPath);
          if (now - stats.mtimeMs < maxAgeMs) {
            return;
          }

          await fs.rm(entryPath, { force: true });
        } catch {
          return;
        }
      })
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

export class JsonFileStore<T> {
  private cache: T | null = null;
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly defaults: T
  ) {}

  async read(): Promise<T> {
    return this.runExclusive(async () => this.readInternal());
  }

  async write(value: T): Promise<void> {
    await this.runExclusive(async () => {
      await this.writeInternal(value);
    });
  }

  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      const current = await this.readInternal();
      const next = await mutator(current);
      await this.writeInternal(next);
      return clone(next);
    });
  }

  private async readInternal(): Promise<T> {
    await cleanupStaleJsonTempFiles(this.filePath);

    if (this.cache) {
      return clone(this.cache);
    }

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.cache = JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      this.cache = clone(this.defaults);
      await this.writeInternal(this.cache);
    }

    return clone(this.cache);
  }

  private async writeInternal(value: T): Promise<void> {
    this.cache = clone(value);
    await ensureParentDirectory(this.filePath);
    await cleanupStaleJsonTempFiles(this.filePath);

    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;

    try {
      await fs.writeFile(
        temporaryPath,
        JSON.stringify(this.cache, null, 2),
        'utf8'
      );
      await replaceFileWithRetries(temporaryPath, this.filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private runExclusive<R>(operation: () => Promise<R>): Promise<R> {
    const nextOperation = this.operationQueue.then(operation, operation);
    this.operationQueue = nextOperation.then(
      () => undefined,
      () => undefined
    );
    return nextOperation;
  }
}

export async function appendJsonLine<T>(
  filePath: string,
  entry: T
): Promise<void> {
  await ensureParentDirectory(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function readJsonLines<T>(
  filePath: string,
  limit?: number
): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = raw
      .split(/\r?\n/g)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is T => entry !== null);

    return typeof limit === 'number' && limit > 0
      ? parsed.slice(-limit)
      : parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

export async function ensureDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
}
