import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { InMemorySessionStore } from '@assem/memory';
import { FileTaskManager } from '@assem/task-manager';
import { ToolRegistry } from '@assem/tool-registry';
import type {
  AssemTask,
  MemoryBackend,
  ModelRequest,
  ModelResponse,
  ModelRouter,
  ProfileCreateInput,
  ProfileImportPayload,
  ProfileMemory,
  ProfileSummary,
  ProviderHealth,
  ProviderSummary,
  ResearchTaskMetadata,
  TaskRuntimeEvent,
  ToolDefinition,
  WebPageFetchInput,
  WebPageFetchOutput,
  WebSearchInput,
  WebSearchOutput
} from '@assem/shared-types';

import {
  TaskRuntimeExecutor
} from './index';
import {
  RESEARCH_QUALITY_FIXTURES,
  type ResearchQualityFixtureCase
} from './research-quality.fixtures';

const temporaryDirectories = new Set<string>();

async function waitForTask(
  taskManager: FileTaskManager,
  taskId: string,
  timeoutMs = 6_000
): Promise<AssemTask> {
  const startedAt = Date.now();
  let lastTask: AssemTask | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const task = await taskManager.getTask(taskId);
    lastTask = task ?? null;
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `Timed out waiting for task ${taskId}. Last state: ${JSON.stringify(
      lastTask
        ? {
            status: lastTask.status,
            currentPhase: lastTask.currentPhase,
            failureReason: lastTask.failureReason
          }
        : null
    )}`
  );
}

class TestMemoryBackend implements MemoryBackend {
  private profile: ProfileMemory = {
    id: 'profile-quality',
    name: 'Research QA profile',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isActive: true,
    preferences: {},
    notes: [],
    contacts: [],
    savedSummaries: [],
    derivedData: {}
  };

  async createProfile(input: ProfileCreateInput): Promise<ProfileMemory> {
    this.profile = {
      ...this.profile,
      id: crypto.randomUUID(),
      name: input.name,
      updatedAt: new Date().toISOString(),
      preferences: input.preferences ?? {},
      notes: input.notes ?? [],
      contacts: input.contacts ?? [],
      savedSummaries: input.savedSummaries ?? [],
      derivedData: input.derivedData ?? {},
      isActive: true
    };
    return this.profile;
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    return [
      {
        id: this.profile.id,
        name: this.profile.name,
        isActive: this.profile.isActive,
        updatedAt: this.profile.updatedAt,
        notesCount: this.profile.notes.length,
        contactsCount: this.profile.contacts.length,
        summariesCount: this.profile.savedSummaries.length
      }
    ];
  }

  async getActiveProfile(): Promise<ProfileMemory | null> {
    return this.profile;
  }

  async activateProfile(): Promise<ProfileMemory> {
    return this.profile;
  }

  async exportProfile(): Promise<ProfileMemory> {
    return this.profile;
  }

  async importProfile(payload: ProfileImportPayload): Promise<ProfileMemory> {
    this.profile = payload.profile;
    return this.profile;
  }

  async resetProfile(): Promise<ProfileMemory> {
    return this.profile;
  }
}

function createModelRouter(): ModelRouter {
  return {
    listProviders(): ProviderSummary[] {
      return [
        {
          id: 'demo-local',
          label: 'Demo local provider',
          configured: true,
          defaultModel: 'demo-local-heuristic',
          supportsLocalOnly: true,
          capabilities: ['chat', 'tool_reasoning', 'telemetry'],
          supportsPrivacyModes: [
            'local_only',
            'prefer_local',
            'balanced',
            'cloud_allowed'
          ]
        }
      ];
    },
    async healthCheck(): Promise<ProviderHealth[]> {
      return [
        {
          providerId: 'demo-local',
          label: 'Demo local provider',
          status: 'ok',
          checkedAt: new Date().toISOString(),
          configured: true,
          supportsLocalOnly: true,
          defaultModel: 'demo-local-heuristic',
          capabilities: ['chat', 'tool_reasoning', 'telemetry'],
          supportsPrivacyModes: [
            'local_only',
            'prefer_local',
            'balanced',
            'cloud_allowed'
          ]
        }
      ];
    },
    async respond(_request: ModelRequest): Promise<ModelResponse> {
      return {
        text: [
          '# Informe de investigacion',
          '',
          '## Titulo',
          'Informe de research',
          '',
          '## Objetivo',
          'Responder a la consulta con evidencia real.',
          '',
          '## Resumen ejecutivo',
          'Borrador sintetizado solo a partir de evidencia persistida.',
          '',
          '## Hallazgos fuertemente apoyados',
          '- Solo usar evidencia fuerte o media cuando exista.',
          '',
          '## Hallazgos probables pero limitados',
          '- Si la evidencia es parcial, mantener lenguaje prudente.',
          '',
          '## Senales debiles o tangenciales',
          '- Contexto secundario y no base principal.'
        ].join('\n'),
        confidence: 0.82,
        providerId: 'demo-local',
        model: 'demo-local-heuristic',
        usage: {
          latencyMs: 6,
          estimatedCostUsd: 0
        }
      };
    }
  };
}

function createWebSearchTool(
  fixture: ResearchQualityFixtureCase
): ToolDefinition<WebSearchInput, WebSearchOutput> {
  return {
    id: 'web-search.search',
    label: 'Fixture web search',
    description: 'Returns deterministic research quality fixtures.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['external_communication', 'read_only'],
    async execute(input) {
      return {
        summary: `Found ${fixture.searchResults.length} result(s).`,
        output: {
          providerId: 'mock-brave',
          query: input.query,
          retrievedAt: fixture.searchResults[0]?.retrievedAt ?? new Date().toISOString(),
          results: fixture.searchResults
        }
      };
    }
  };
}

function createPageReaderTool(
  fixture: ResearchQualityFixtureCase
): ToolDefinition<WebPageFetchInput, WebPageFetchOutput> {
  return {
    id: 'web-page-reader.fetch-page',
    label: 'Fixture page reader',
    description: 'Returns deterministic fetched page outputs.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['external_communication', 'read_only'],
    async execute(input) {
      const override = fixture.pageFetchByUrl[input.url];
      if (override instanceof Error) {
        throw override;
      }

      const output: WebPageFetchOutput = {
        url: input.url,
        finalUrl: override?.finalUrl ?? input.url,
        title: override?.title ?? 'Fixture source',
        contentText: override?.contentText,
        excerpt: override?.excerpt,
        contentLength:
          override?.contentLength ??
          (override?.contentText ? override.contentText.length : undefined),
        fetchedAt: override?.fetchedAt ?? new Date().toISOString(),
        status: override?.status ?? 'ok',
        httpStatus: override?.httpStatus ?? 200,
        contentType: override?.contentType ?? 'text/html',
        readQuality: override?.readQuality,
        qualityScore: override?.qualityScore,
        textDensity: override?.textDensity,
        linkDensity: override?.linkDensity,
        qualityNotes: override?.qualityNotes,
        errorMessage: override?.errorMessage,
        safetyNotes: override?.safetyNotes
      };

      return {
        summary: `${output.status} for ${input.url}`,
        output
      };
    }
  };
}

async function createRuntimeHarness(fixture: ResearchQualityFixtureCase) {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-research-quality-sandbox-'));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-research-quality-data-'));
  temporaryDirectories.add(sandboxRoot);
  temporaryDirectories.add(dataRoot);

  const taskManager = new FileTaskManager(path.join(dataRoot, 'tasks.json'));
  const sessionStore = new InMemorySessionStore('demo-local');
  const session = await sessionStore.createSession();
  session.activeMode = {
    privacy: 'balanced',
    runtime: 'sandbox'
  };
  await sessionStore.saveSession(session);

  const events: TaskRuntimeEvent[] = [];
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createWebSearchTool(fixture));
  toolRegistry.register(createPageReaderTool(fixture));

  const runtime = new TaskRuntimeExecutor(
    {
      taskManager,
      sessionStore,
      memoryBackend: new TestMemoryBackend(),
      toolRegistry,
      modelRouter: createModelRouter(),
      sandboxRoot,
      dataRoot,
      researchPageFetchEnabled: true,
      researchPageFetchMaxSources: 3
    },
    {
      onEvent: async (event) => {
        events.push(event);
      }
    }
  );

  return {
    sandboxRoot,
    taskManager,
    runtime,
    sessionId: session.sessionId,
    events
  };
}

function getResearchMetadata(task: AssemTask): ResearchTaskMetadata {
  const research = task.metadata?.research;
  if (!research || typeof research !== 'object') {
    throw new Error('Research metadata was not persisted.');
  }

  return research as ResearchTaskMetadata;
}

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('Research QA / Tuning fixtures', () => {
  it.each(RESEARCH_QUALITY_FIXTURES)(
    'evaluates research quality fixture $id',
    async (fixture) => {
      const { runtime, taskManager, sessionId } = await createRuntimeHarness(fixture);
      const createdTask = await runtime.createTask({
        sessionId,
        taskType: 'research_report_basic',
        objective: fixture.objective,
        autoStart: true
      });

      const finalTask = await waitForTask(taskManager, createdTask.id);
      const research = getResearchMetadata(finalTask);
      const qualitySummary = research.qualitySummary;

      expect(finalTask.status).toBe(fixture.expected.status);
      expect(qualitySummary).toBeDefined();
      expect(research.reportReadiness).toBe(fixture.expected.reportReadiness);
      expect(qualitySummary?.reportReadiness).toBe(fixture.expected.reportReadiness);
      expect(qualitySummary?.selectedSourcesCount).toBe(research.sourcesSelected.length);
      expect(qualitySummary?.strongEvidenceCount).toBe(
        (research.evidence ?? []).filter((record) => record.evidenceStrength === 'strong').length
      );

      if (fixture.expected.selectedAtLeast !== undefined) {
        expect(research.sourcesSelected.length).toBeGreaterThanOrEqual(
          fixture.expected.selectedAtLeast
        );
      }

      if (fixture.expected.strongAtLeast !== undefined) {
        expect(qualitySummary?.strongEvidenceCount ?? 0).toBeGreaterThanOrEqual(
          fixture.expected.strongAtLeast
        );
      }

      if (fixture.expected.tangentialAtLeast !== undefined) {
        expect(qualitySummary?.tangentialSourcesCount ?? 0).toBeGreaterThanOrEqual(
          fixture.expected.tangentialAtLeast
        );
      }

      if (fixture.expected.highQualityReadsAtLeast !== undefined) {
        expect(qualitySummary?.highQualityReadCount ?? 0).toBeGreaterThanOrEqual(
          fixture.expected.highQualityReadsAtLeast
        );
      }

      if (fixture.expected.snippetDominant !== undefined) {
        expect(Boolean(qualitySummary?.snippetDominant)).toBe(
          fixture.expected.snippetDominant
        );
      }

      const reportArtifact = finalTask.artifacts.find((artifact) => artifact.kind === 'report');
      if (fixture.expected.reportMustExist) {
        expect(reportArtifact?.filePath).toBeDefined();
        const reportContents = await fs.readFile(reportArtifact!.filePath!, 'utf8');
        for (const fragment of fixture.expected.reportMustMention ?? []) {
          expect(reportContents).toContain(fragment);
        }
      } else {
        expect(reportArtifact).toBeUndefined();
      }
    }
  );

  it('persists an auditable quality summary with enough metrics to inspect the run', async () => {
    const fixture = RESEARCH_QUALITY_FIXTURES.find((candidate) => candidate.id === 'soft_drinks_usa');
    if (!fixture) {
      throw new Error('Fixture soft_drinks_usa not found.');
    }

    const { runtime, taskManager, sessionId } = await createRuntimeHarness(fixture);
    const createdTask = await runtime.createTask({
      sessionId,
      taskType: 'research_report_basic',
      objective: fixture.objective,
      autoStart: true
    });
    const finalTask = await waitForTask(taskManager, createdTask.id);
    const research = getResearchMetadata(finalTask);
    const qualitySummary = research.qualitySummary;

    expect(qualitySummary).toMatchObject({
      selectedSourcesCount: expect.any(Number),
      readSourcesCount: expect.any(Number),
      highQualityReadCount: expect.any(Number),
      snippetOnlyCount: expect.any(Number),
      strongEvidenceCount: expect.any(Number),
      reportReadiness: expect.any(String),
      readinessReason: expect.any(String),
      limitationsRequired: expect.any(Boolean)
    });
  });
});
