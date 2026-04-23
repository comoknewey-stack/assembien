import path from 'node:path';

import { JsonFileStore } from '@assem/persistence';
import type {
  ActiveMode,
  CalendarEvent,
  MemoryBackend,
  ProfileCreateInput,
  ProfileImportPayload,
  ProfileMemory,
  ProfileSummary,
  SessionSettings,
  SessionState,
  SessionStore,
  SessionSummary
} from '@assem/shared-types';

interface SessionFileShape {
  sessions: SessionState[];
}

interface ProfileFileShape {
  activeProfileId: string | null;
  profiles: ProfileMemory[];
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

function createSeedEvents(now: Date): CalendarEvent[] {
  const planningStart = addMinutes(now, 90);
  const planningEnd = addMinutes(planningStart, 30);

  const inboxStart = addMinutes(now, 240);
  const inboxEnd = addMinutes(inboxStart, 45);

  return [
    {
      id: crypto.randomUUID(),
      title: 'Weekly planning',
      startsAt: planningStart.toISOString(),
      endsAt: planningEnd.toISOString(),
      notes: 'Mock event seeded by the MVP calendar provider.',
      source: 'mock'
    },
    {
      id: crypto.randomUUID(),
      title: 'Inbox triage',
      startsAt: inboxStart.toISOString(),
      endsAt: inboxEnd.toISOString(),
      source: 'mock'
    }
  ];
}

function createDefaultMode(): ActiveMode {
  return {
    privacy: 'local_only',
    runtime: 'sandbox'
  };
}

function createDefaultSettings(
  preferredProviderId: string
): SessionSettings {
  return {
    preferredProviderId,
    autoApproveLowRisk: false
  };
}

function touchSession(session: SessionState): SessionState {
  return {
    ...session,
    updatedAt: new Date().toISOString()
  };
}

function createSessionState(defaultProviderId: string): SessionState {
  const now = new Date().toISOString();

  return {
    sessionId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    messages: [],
    actionLog: [],
    pendingAction: null,
    temporaryOverrides: [],
    calendarEvents: createSeedEvents(new Date(now)),
    activeMode: createDefaultMode(),
    settings: createDefaultSettings(defaultProviderId),
    operationalContext: {}
  };
}

function summarizeSession(session: SessionState): SessionSummary {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    hasPendingAction: session.pendingAction?.status === 'pending',
    activeMode: session.activeMode
  };
}

function createProfile(input: ProfileCreateInput): ProfileMemory {
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    name: input.name.trim() || 'Default profile',
    createdAt: now,
    updatedAt: now,
    isActive: false,
    preferences: input.preferences ?? {},
    notes: input.notes ?? [],
    contacts: input.contacts ?? [],
    savedSummaries: input.savedSummaries ?? [],
    derivedData: input.derivedData ?? {}
  };
}

function summarizeProfile(profile: ProfileMemory): ProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    isActive: profile.isActive,
    updatedAt: profile.updatedAt,
    notesCount: profile.notes.length,
    contactsCount: profile.contacts.length,
    summariesCount: profile.savedSummaries.length
  };
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly defaultProviderId: string) {}

  async createSession(): Promise<SessionState> {
    const session = createSessionState(this.defaultProviderId);
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async getSession(sessionId: string): Promise<SessionState | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async getOrCreateSession(sessionId?: string): Promise<SessionState> {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        return existing;
      }
    }

    return this.createSession();
  }

  async saveSession(session: SessionState): Promise<void> {
    this.sessions.set(session.sessionId, touchSession(session));
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [...this.sessions.values()]
      .map(summarizeSession)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

export class FileSessionStore implements SessionStore {
  private readonly store: JsonFileStore<SessionFileShape>;

  constructor(
    filePath: string,
    private readonly defaultProviderId: string
  ) {
    this.store = new JsonFileStore(filePath, { sessions: [] });
  }

  async createSession(): Promise<SessionState> {
    const session = createSessionState(this.defaultProviderId);

    await this.store.update((current) => ({
      sessions: [...current.sessions, session]
    }));

    return session;
  }

  async getSession(sessionId: string): Promise<SessionState | null> {
    const current = await this.store.read();
    return (
      current.sessions.find((session) => session.sessionId === sessionId) ?? null
    );
  }

  async getOrCreateSession(sessionId?: string): Promise<SessionState> {
    if (sessionId) {
      const existing = await this.getSession(sessionId);
      if (existing) {
        return existing;
      }
    }

    return this.createSession();
  }

  async saveSession(session: SessionState): Promise<void> {
    const next = touchSession(session);

    await this.store.update((current) => {
      const index = current.sessions.findIndex(
        (entry) => entry.sessionId === next.sessionId
      );

      if (index === -1) {
        return {
          sessions: [...current.sessions, next]
        };
      }

      const sessions = [...current.sessions];
      sessions[index] = next;

      return { sessions };
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    const current = await this.store.read();

    return current.sessions
      .map(summarizeSession)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

export class FileProfileMemoryBackend implements MemoryBackend {
  private readonly store: JsonFileStore<ProfileFileShape>;

  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, {
      activeProfileId: null,
      profiles: []
    });
  }

  async createProfile(input: ProfileCreateInput): Promise<ProfileMemory> {
    const profile = createProfile(input);

    await this.store.update((current) => {
      const shouldActivate = current.activeProfileId === null;
      const profiles = current.profiles
        .map((entry) => ({
          ...entry,
          isActive: shouldActivate ? false : entry.isActive
        }))
        .concat({
          ...profile,
          isActive: shouldActivate
        });

      return {
        activeProfileId: shouldActivate ? profile.id : current.activeProfileId,
        profiles
      };
    });

    return (await this.exportProfile(profile.id)) as ProfileMemory;
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    const current = await this.store.read();

    return current.profiles
      .map(summarizeProfile)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getActiveProfile(): Promise<ProfileMemory | null> {
    const current = await this.store.read();
    if (!current.activeProfileId) {
      return null;
    }

    return (
      current.profiles.find((profile) => profile.id === current.activeProfileId) ??
      null
    );
  }

  async activateProfile(profileId: string): Promise<ProfileMemory> {
    await this.store.update((current) => {
      const found = current.profiles.some((profile) => profile.id === profileId);
      if (!found) {
        throw new Error(`Unknown profile: ${profileId}`);
      }

      return {
        activeProfileId: profileId,
        profiles: current.profiles.map((profile) => ({
          ...profile,
          isActive: profile.id === profileId,
          updatedAt:
            profile.id === profileId ? new Date().toISOString() : profile.updatedAt
        }))
      };
    });

    return (await this.exportProfile(profileId)) as ProfileMemory;
  }

  async exportProfile(profileId: string): Promise<ProfileMemory> {
    const current = await this.store.read();
    const profile = current.profiles.find((entry) => entry.id === profileId);

    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    return profile;
  }

  async importProfile(payload: ProfileImportPayload): Promise<ProfileMemory> {
    const imported: ProfileMemory = {
      ...payload.profile,
      id: payload.profile.id || crypto.randomUUID(),
      name: payload.profile.name.trim() || 'Imported profile',
      updatedAt: new Date().toISOString(),
      isActive: false
    };

    await this.store.update((current) => {
      const profiles = current.profiles.filter(
        (profile) => profile.id !== imported.id
      );

      const shouldActivate = payload.activate ?? current.activeProfileId === null;

      return {
        activeProfileId: shouldActivate ? imported.id : current.activeProfileId,
        profiles: profiles
          .map((profile) => ({
            ...profile,
            isActive: shouldActivate ? false : profile.isActive
          }))
          .concat({
            ...imported,
            isActive: shouldActivate
          })
      };
    });

    return this.exportProfile(imported.id);
  }

  async resetProfile(profileId: string): Promise<ProfileMemory> {
    await this.store.update((current) => {
      const index = current.profiles.findIndex((profile) => profile.id === profileId);
      if (index === -1) {
        throw new Error(`Unknown profile: ${profileId}`);
      }

      const existing = current.profiles[index];
      const reset: ProfileMemory = {
        ...existing,
        updatedAt: new Date().toISOString(),
        preferences: {},
        notes: [],
        contacts: [],
        savedSummaries: [],
        derivedData: {}
      };

      const profiles = [...current.profiles];
      profiles[index] = reset;

      return {
        activeProfileId: current.activeProfileId,
        profiles
      };
    });

    return this.exportProfile(profileId);
  }
}

export function createSessionStorePaths(dataRoot: string): {
  sessionsFilePath: string;
  profilesFilePath: string;
} {
  return {
    sessionsFilePath: path.join(dataRoot, 'sessions.json'),
    profilesFilePath: path.join(dataRoot, 'profiles.json')
  };
}

export { summarizeProfile };
