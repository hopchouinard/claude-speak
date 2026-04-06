# Session Mute & Multi-Provider TTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session mute/unmute, ElevenLabs as a second TTS provider, and a subcommand system to control both from within a Claude Code session.

**Architecture:** Restructure config from flat to nested provider blocks with auto-migration. Add a session.json overlay for transient state (mute). Add a subcommand dispatcher (--cmd flag) alongside existing --say and --trigger modes. Implement ElevenLabs provider using raw fetch against the convert endpoint. Add voice cache for ElevenLabs name-to-ID resolution.

**Tech Stack:** TypeScript, Vitest, esbuild, OpenAI SDK, ElevenLabs REST API (raw fetch), Node.js fs/path/os

---

### Task 1: Config Restructure — Types and Migration

**Files:**
- Modify: `src/config.ts`
- Create: `src/migration.ts`
- Modify: `test/config.test.ts`
- Create: `test/migration.test.ts`

- [ ] **Step 1: Write migration detection and transform tests**

Create `test/migration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isOldFormat, migrateConfig } from '../src/migration.js';

describe('isOldFormat', () => {
  it('detects old flat format (has provider, no providers block)', () => {
    const old = { provider: 'openai', voice: 'ash', model: 'gpt-4o-mini-tts-2025-12-15' };
    expect(isOldFormat(old)).toBe(true);
  });

  it('returns false for new nested format', () => {
    const newFmt = { activeProvider: 'openai', providers: { openai: { voice: 'ash' } } };
    expect(isOldFormat(newFmt)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isOldFormat({})).toBe(false);
  });
});

describe('migrateConfig', () => {
  it('moves provider-specific fields under providers.openai', () => {
    const old = {
      provider: 'openai',
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'Marin',
      instructions: 'Be cheeky',
      speed: 1.2,
      hooks: { stop: true, notification: true },
      playback: { command: 'afplay' },
      cooldown: 10,
      timeout: 30,
      logFile: '~/.claude-speak/logs/voice.log',
    };
    const result = migrateConfig(old);
    expect(result.activeProvider).toBe('openai');
    expect(result.providers.openai).toEqual({
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'Marin',
      instructions: 'Be cheeky',
      speed: 1.2,
    });
    expect(result.hooks).toEqual({ stop: true, notification: true });
    expect(result.cooldown).toBe(10);
    expect(result.timeout).toBe(30);
    expect(result.logFile).toBe('~/.claude-speak/logs/voice.log');
    expect(result.playback).toEqual({ command: 'afplay' });
  });

  it('uses defaults for missing provider fields', () => {
    const old = { provider: 'openai', voice: 'ash' };
    const result = migrateConfig(old);
    expect(result.providers.openai.model).toBe('gpt-4o-mini-tts-2025-12-15');
    expect(result.providers.openai.speed).toBe(1.0);
  });

  it('preserves extra shared settings', () => {
    const old = { provider: 'openai', voice: 'ash', cooldown: 5 };
    const result = migrateConfig(old);
    expect(result.cooldown).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/migration.test.ts`
Expected: FAIL — module `../src/migration.js` does not exist

- [ ] **Step 3: Implement migration module**

Create `src/migration.ts`:

```typescript
export interface ProviderConfig {
  model: string;
  voice: string;
  voiceId?: string;
  instructions?: string;
  speed: number;
  // ElevenLabs-specific
  stability?: number;
  similarityBoost?: number;
  style?: number;
}

export interface NewFormatConfig {
  activeProvider: string;
  providers: Record<string, ProviderConfig>;
  hooks: { stop: boolean; notification: boolean };
  playback: { command: string };
  cooldown: number;
  timeout: number;
  logFile: string;
}

const PROVIDER_FIELDS = ['model', 'voice', 'voiceId', 'instructions', 'speed', 'stability', 'similarityBoost', 'style'] as const;

export function isOldFormat(config: Record<string, unknown>): boolean {
  return typeof config.provider === 'string' && !config.providers;
}

export function migrateConfig(old: Record<string, unknown>): NewFormatConfig {
  const providerName = (old.provider as string) || 'openai';

  // Extract provider-specific fields
  const providerConfig: Record<string, unknown> = {};
  for (const field of PROVIDER_FIELDS) {
    if (old[field] !== undefined) {
      providerConfig[field] = old[field];
    }
  }

  // Ensure defaults for required provider fields
  if (!providerConfig.model) providerConfig.model = 'gpt-4o-mini-tts-2025-12-15';
  if (!providerConfig.voice) providerConfig.voice = 'ash';
  if (providerConfig.speed == null) providerConfig.speed = 1.0;

  return {
    activeProvider: providerName,
    providers: {
      [providerName]: providerConfig as unknown as ProviderConfig,
    },
    hooks: (old.hooks as { stop: boolean; notification: boolean }) ?? { stop: true, notification: true },
    playback: (old.playback as { command: string }) ?? { command: 'afplay' },
    cooldown: (old.cooldown as number) ?? 15,
    timeout: (old.timeout as number) ?? 30,
    logFile: (old.logFile as string) ?? '~/.claude-speak/logs/voice.log',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/migration.test.ts`
Expected: PASS — all 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/migration.ts test/migration.test.ts
git commit -m "feat: add config migration module for old-to-new format detection and transform"
```

---

### Task 2: Rewrite Config Loader for Nested Format

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write tests for new config loader**

Replace `test/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');

describe('loadConfig', () => {
  const mockHome = '/mock/home';

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns defaults when no config file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const config = loadConfig();
    expect(config.activeProvider).toBe('openai');
    expect(config.providers.openai.model).toBe('gpt-4o-mini-tts-2025-12-15');
    expect(config.providers.openai.voice).toBe('ash');
    expect(config.enabled).toBe(false);
  });

  it('loads new nested config format', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      activeProvider: 'openai',
      providers: {
        openai: { voice: 'nova', instructions: 'Be sassy', model: 'gpt-4o-mini-tts-2025-12-15', speed: 1.0 },
      },
    }));
    const config = loadConfig();
    expect(config.providers.openai.voice).toBe('nova');
    expect(config.providers.openai.instructions).toBe('Be sassy');
    expect(config.activeProvider).toBe('openai');
    expect(config.enabled).toBe(true);
  });

  it('auto-migrates old flat format', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      provider: 'openai',
      voice: 'Marin',
      instructions: 'Be cheeky',
      speed: 1.2,
    }));
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    const config = loadConfig();
    expect(config.activeProvider).toBe('openai');
    expect(config.providers.openai.voice).toBe('Marin');
    expect(config.providers.openai.speed).toBe(1.2);
    // Verify it tried to write migrated config
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('continues in memory if migration write fails', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      provider: 'openai',
      voice: 'ash',
    }));
    vi.mocked(fs.writeFileSync).mockImplementation(() => { throw new Error('permission denied'); });
    const config = loadConfig();
    // Should still work with migrated config in memory
    expect(config.activeProvider).toBe('openai');
    expect(config.providers.openai.voice).toBe('ash');
  });

  it('respects CLAUDE_SPEAK_ENABLED=false env override', () => {
    vi.stubEnv('CLAUDE_SPEAK_ENABLED', 'false');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      activeProvider: 'openai',
      providers: { openai: { voice: 'ash', model: 'gpt-4o-mini-tts-2025-12-15', speed: 1.0 } },
    }));
    const config = loadConfig();
    expect(config.enabled).toBe(false);
  });

  it('reads OpenAI API key from env', () => {
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY', 'sk-test');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      activeProvider: 'openai',
      providers: { openai: { voice: 'ash', model: 'gpt-4o-mini-tts-2025-12-15', speed: 1.0 } },
    }));
    const config = loadConfig();
    expect(config.apiKeys.openai).toBe('sk-test');
  });

  it('reads ElevenLabs API key from env', () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'xi-test');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      activeProvider: 'elevenlabs',
      providers: { elevenlabs: { voice: 'Rachel', model: 'eleven_multilingual_v2', speed: 1.0 } },
    }));
    const config = loadConfig();
    expect(config.apiKeys.elevenlabs).toBe('xi-test');
  });

  it('handles malformed config file gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');
    const config = loadConfig();
    expect(config.enabled).toBe(false);
    expect(config.error).toBe('malformed-config');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `activeProvider` and `providers` not found on config type

- [ ] **Step 3: Rewrite config.ts for nested format**

Replace `src/config.ts`:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isOldFormat, migrateConfig, type ProviderConfig } from './migration.js';

export interface ApiKeys {
  openai: string | null;
  elevenlabs: string | null;
}

export interface VoiceConfig {
  enabled: boolean;
  activeProvider: string;
  providers: Record<string, ProviderConfig>;
  apiKeys: ApiKeys;
  hooks: {
    stop: boolean;
    notification: boolean;
  };
  playback: {
    command: string;
  };
  cooldown: number;
  timeout: number;
  logFile: string;
  error?: 'malformed-config';
}

const OPENAI_PROVIDER_DEFAULTS: ProviderConfig = {
  model: 'gpt-4o-mini-tts-2025-12-15',
  voice: 'ash',
  speed: 1.0,
};

const ELEVENLABS_PROVIDER_DEFAULTS: ProviderConfig = {
  model: 'eleven_multilingual_v2',
  voice: '',
  speed: 1.0,
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0.0,
};

export const PROVIDER_DEFAULTS: Record<string, ProviderConfig> = {
  openai: OPENAI_PROVIDER_DEFAULTS,
  elevenlabs: ELEVENLABS_PROVIDER_DEFAULTS,
};

function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function detectPlaybackCommand(): string {
  return process.platform === 'darwin' ? 'afplay' : 'paplay';
}

function getSharedDefaults() {
  return {
    hooks: { stop: true, notification: true },
    playback: { command: detectPlaybackCommand() },
    cooldown: 15,
    timeout: 30,
    logFile: path.join(os.homedir(), '.claude-speak', 'logs', 'voice.log'),
  };
}

function loadApiKeys(): ApiKeys {
  return {
    openai: process.env.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
    elevenlabs: process.env.CLAUDE_PLUGIN_OPTION_ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? null,
  };
}

function mergeProviderConfig(userConfig: Record<string, unknown>, defaults: ProviderConfig): ProviderConfig {
  return {
    model: (userConfig.model as string) ?? defaults.model,
    voice: (userConfig.voice as string) ?? defaults.voice,
    voiceId: (userConfig.voiceId as string) ?? defaults.voiceId,
    instructions: (userConfig.instructions as string) ?? defaults.instructions,
    speed: (userConfig.speed as number) ?? defaults.speed,
    stability: (userConfig.stability as number) ?? defaults.stability,
    similarityBoost: (userConfig.similarityBoost as number) ?? defaults.similarityBoost,
    style: (userConfig.style as number) ?? defaults.style,
  };
}

export function getConfigPath(): string {
  return path.join(os.homedir(), '.claude-speak.json');
}

export function loadConfig(): VoiceConfig {
  const SHARED_DEFAULTS = getSharedDefaults();
  const configPath = getConfigPath();
  const envEnabled = process.env.CLAUDE_SPEAK_ENABLED;
  const apiKeys = loadApiKeys();

  if (!fs.existsSync(configPath)) {
    return {
      enabled: false,
      activeProvider: 'openai',
      providers: { openai: { ...OPENAI_PROVIDER_DEFAULTS } },
      apiKeys,
      ...SHARED_DEFAULTS,
    };
  }

  let fileConfig: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(raw);
  } catch {
    return {
      enabled: false,
      activeProvider: 'openai',
      providers: { openai: { ...OPENAI_PROVIDER_DEFAULTS } },
      apiKeys,
      ...SHARED_DEFAULTS,
      error: 'malformed-config',
    };
  }

  // Auto-migrate old flat format
  if (isOldFormat(fileConfig)) {
    const migrated = migrateConfig(fileConfig);
    try {
      fs.writeFileSync(configPath, JSON.stringify(migrated, null, 2) + '\n', 'utf-8');
    } catch {
      // Continue with migrated config in memory
    }
    fileConfig = migrated as unknown as Record<string, unknown>;
  }

  // Parse new nested format
  const activeProvider = (fileConfig.activeProvider as string) ?? 'openai';
  const rawProviders = (fileConfig.providers as Record<string, Record<string, unknown>>) ?? {};

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, rawConfig] of Object.entries(rawProviders)) {
    const defaults = PROVIDER_DEFAULTS[name] ?? OPENAI_PROVIDER_DEFAULTS;
    providers[name] = mergeProviderConfig(rawConfig, defaults);
  }

  // Ensure active provider exists in providers map
  if (!providers[activeProvider]) {
    const defaults = PROVIDER_DEFAULTS[activeProvider] ?? OPENAI_PROVIDER_DEFAULTS;
    providers[activeProvider] = { ...defaults };
  }

  return {
    enabled: envEnabled !== undefined ? envEnabled === 'true' : true,
    activeProvider,
    providers,
    apiKeys,
    hooks: {
      stop: (fileConfig.hooks as Record<string, boolean>)?.stop ?? SHARED_DEFAULTS.hooks.stop,
      notification: (fileConfig.hooks as Record<string, boolean>)?.notification ?? SHARED_DEFAULTS.hooks.notification,
    },
    playback: {
      command: (fileConfig.playback as Record<string, string>)?.command ?? SHARED_DEFAULTS.playback.command,
    },
    cooldown: (fileConfig.cooldown as number) ?? SHARED_DEFAULTS.cooldown,
    timeout: (fileConfig.timeout as number) ?? SHARED_DEFAULTS.timeout,
    logFile: expandTilde((fileConfig.logFile as string) ?? SHARED_DEFAULTS.logFile),
  };
}
```

- [ ] **Step 4: Run config tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS — all 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: rewrite config loader for nested provider format with auto-migration"
```

---

### Task 3: Session State Module

**Files:**
- Create: `src/session.ts`
- Create: `test/session.test.ts`

- [ ] **Step 1: Write session state tests**

Create `test/session.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadSession, writeSession, clearSession, type SessionState } from '../src/session.js';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');

describe('session', () => {
  const mockHome = '/mock/home';
  const sessionPath = '/mock/home/.claude-speak/session.json';

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadSession', () => {
    it('returns defaults when session file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const session = loadSession();
      expect(session.muted).toBe(false);
    });

    it('loads muted state from session file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ muted: true }));
      const session = loadSession();
      expect(session.muted).toBe(true);
    });

    it('deletes corrupted session file and returns defaults', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not json{{{');
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
      const session = loadSession();
      expect(session.muted).toBe(false);
      expect(fs.unlinkSync).toHaveBeenCalledWith(sessionPath);
    });
  });

  describe('writeSession', () => {
    it('writes session state to file', () => {
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      writeSession({ muted: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        sessionPath,
        JSON.stringify({ muted: true }, null, 2) + '\n',
        'utf-8'
      );
    });
  });

  describe('clearSession', () => {
    it('deletes session file if it exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
      clearSession();
      expect(fs.unlinkSync).toHaveBeenCalledWith(sessionPath);
    });

    it('does nothing if session file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      clearSession();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL — module `../src/session.js` does not exist

- [ ] **Step 3: Implement session module**

Create `src/session.ts`:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SessionState {
  muted: boolean;
}

const SESSION_DEFAULTS: SessionState = {
  muted: false,
};

function getSessionPath(): string {
  return path.join(os.homedir(), '.claude-speak', 'session.json');
}

export function loadSession(): SessionState {
  const sessionPath = getSessionPath();

  if (!fs.existsSync(sessionPath)) {
    return { ...SESSION_DEFAULTS };
  }

  try {
    const raw = fs.readFileSync(sessionPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : SESSION_DEFAULTS.muted,
    };
  } catch {
    // Corrupted session file — delete it and return defaults
    try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }
    return { ...SESSION_DEFAULTS };
  }
}

export function writeSession(state: SessionState): void {
  const sessionPath = getSessionPath();
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export function clearSession(): void {
  const sessionPath = getSessionPath();
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/session.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/session.ts test/session.test.ts
git commit -m "feat: add session state module for transient mute state"
```

---

### Task 4: ElevenLabs TTS Provider

**Files:**
- Modify: `src/tts/interface.ts`
- Create: `src/tts/elevenlabs.ts`
- Create: `src/voice-cache.ts`
- Create: `test/tts-elevenlabs.test.ts`
- Create: `test/voice-cache.test.ts`

- [ ] **Step 1: Write voice cache tests**

Create `test/voice-cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readCache, resolveVoiceName, writeCache, type VoiceCacheEntry } from '../src/voice-cache.js';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');

describe('voice-cache', () => {
  const mockHome = '/mock/home';
  const cachePath = '/mock/home/.claude-speak/voices-elevenlabs.json';

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readCache', () => {
    it('returns null when cache file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(readCache()).toBeNull();
    });

    it('returns parsed cache data', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        fetched: '2026-04-05T12:00:00Z',
        voices: [{ name: 'Rachel', voiceId: 'abc123', category: 'premade' }],
      }));
      const cache = readCache();
      expect(cache).not.toBeNull();
      expect(cache!.voices).toHaveLength(1);
      expect(cache!.voices[0].name).toBe('Rachel');
    });

    it('returns null for corrupted cache', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('bad json');
      expect(readCache()).toBeNull();
    });
  });

  describe('resolveVoiceName', () => {
    const voices: VoiceCacheEntry[] = [
      { name: 'Rachel', voiceId: 'abc123', category: 'premade' },
      { name: 'My Clone', voiceId: 'def456', category: 'cloned' },
    ];

    it('resolves name case-insensitively', () => {
      expect(resolveVoiceName('rachel', voices)).toBe('abc123');
      expect(resolveVoiceName('RACHEL', voices)).toBe('abc123');
      expect(resolveVoiceName('Rachel', voices)).toBe('abc123');
    });

    it('returns null for unknown name', () => {
      expect(resolveVoiceName('Unknown', voices)).toBeNull();
    });
  });

  describe('writeCache', () => {
    it('writes cache to file', () => {
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      const entries: VoiceCacheEntry[] = [{ name: 'Rachel', voiceId: 'abc123', category: 'premade' }];
      writeCache(entries);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        cachePath,
        expect.stringContaining('"Rachel"'),
        'utf-8'
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/voice-cache.test.ts`
Expected: FAIL ��� module `../src/voice-cache.js` does not exist

- [ ] **Step 3: Implement voice cache module**

Create `src/voice-cache.ts`:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface VoiceCacheEntry {
  name: string;
  voiceId: string;
  category: string;
}

export interface VoiceCache {
  fetched: string;
  voices: VoiceCacheEntry[];
}

function getCachePath(): string {
  return path.join(os.homedir(), '.claude-speak', 'voices-elevenlabs.json');
}

export function readCache(): VoiceCache | null {
  const cachePath = getCachePath();
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    return JSON.parse(raw) as VoiceCache;
  } catch {
    return null;
  }
}

export function writeCache(voices: VoiceCacheEntry[]): void {
  const cachePath = getCachePath();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const data: VoiceCache = {
    fetched: new Date().toISOString(),
    voices,
  };
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function resolveVoiceName(name: string, voices: VoiceCacheEntry[]): string | null {
  const lower = name.toLowerCase();
  const match = voices.find((v) => v.name.toLowerCase() === lower);
  return match ? match.voiceId : null;
}

export async function fetchElevenLabsVoices(apiKey: string): Promise<VoiceCacheEntry[]> {
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as { voices: Array<{ name: string; voice_id: string; category: string }> };
  return data.voices.map((v) => ({
    name: v.name,
    voiceId: v.voice_id,
    category: v.category,
  }));
}
```

- [ ] **Step 4: Run voice cache tests to verify they pass**

Run: `npx vitest run test/voice-cache.test.ts`
Expected: PASS — all 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/voice-cache.ts test/voice-cache.test.ts
git commit -m "feat: add voice cache module for ElevenLabs name-to-ID resolution"
```

- [ ] **Step 6: Update TTSOptions interface**

Modify `src/tts/interface.ts`:

```typescript
export interface TTSOptions {
  voice: string;
  voiceId?: string;
  model: string;
  instructions?: string;
  speed?: number;
  // ElevenLabs-specific
  stability?: number;
  similarityBoost?: number;
  style?: number;
}

export interface TTSProvider {
  synthesize(text: string, options: TTSOptions): Promise<Buffer>;
}
```

- [ ] **Step 7: Write ElevenLabs provider tests**

Create `test/tts-elevenlabs.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElevenLabsTTSProvider } from '../src/tts/elevenlabs.js';

describe('ElevenLabsTTSProvider', () => {
  let provider: ElevenLabsTTSProvider;

  beforeEach(() => {
    provider = new ElevenLabsTTSProvider('xi-test-key');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls ElevenLabs API with correct URL and headers', async () => {
    const fakeAudio = new ArrayBuffer(8);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    } as Response);

    await provider.synthesize('Hello world', {
      voice: 'Rachel',
      voiceId: 'abc123',
      model: 'eleven_multilingual_v2',
      speed: 1.2,
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0.0,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/text-to-speech/abc123',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'xi-api-key': 'xi-test-key',
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        }),
      })
    );

    const callBody = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(callBody.text).toBe('Hello world');
    expect(callBody.model_id).toBe('eleven_multilingual_v2');
    expect(callBody.voice_settings.speed).toBe(1.2);
    expect(callBody.voice_settings.stability).toBe(0.5);
    expect(callBody.voice_settings.similarity_boost).toBe(0.75);
    expect(callBody.voice_settings.style).toBe(0.0);
  });

  it('returns audio buffer from API response', async () => {
    const fakeAudio = new ArrayBuffer(8);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    } as Response);

    const result = await provider.synthesize('Hello', {
      voice: 'Rachel',
      voiceId: 'abc123',
      model: 'eleven_multilingual_v2',
    });

    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it('throws on API error with status', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as Response);

    await expect(
      provider.synthesize('Hello', { voice: 'Rachel', voiceId: 'abc123', model: 'eleven_multilingual_v2' })
    ).rejects.toThrow('ElevenLabs API error: 401 Unauthorized');
  });

  it('uses voiceId over voice name for URL', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    } as Response);

    await provider.synthesize('Hello', {
      voice: 'Rachel',
      voiceId: 'specific-id-123',
      model: 'eleven_multilingual_v2',
    });

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/specific-id-123'
    );
  });
});
```

- [ ] **Step 8: Run ElevenLabs tests to verify they fail**

Run: `npx vitest run test/tts-elevenlabs.test.ts`
Expected: FAIL — module `../src/tts/elevenlabs.js` does not exist

- [ ] **Step 9: Implement ElevenLabs provider**

Create `src/tts/elevenlabs.ts`:

```typescript
import type { TTSProvider, TTSOptions } from './interface.js';

export class ElevenLabsTTSProvider implements TTSProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async synthesize(text: string, options: TTSOptions): Promise<Buffer> {
    const voiceId = options.voiceId || options.voice;

    const body: Record<string, unknown> = {
      text,
      model_id: options.model,
    };

    const voiceSettings: Record<string, number> = {};
    if (options.speed != null) voiceSettings.speed = options.speed;
    if (options.stability != null) voiceSettings.stability = options.stability;
    if (options.similarityBoost != null) voiceSettings.similarity_boost = options.similarityBoost;
    if (options.style != null) voiceSettings.style = options.style;

    if (Object.keys(voiceSettings).length > 0) {
      body.voice_settings = voiceSettings;
    }

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
```

- [ ] **Step 10: Run ElevenLabs tests to verify they pass**

Run: `npx vitest run test/tts-elevenlabs.test.ts`
Expected: PASS ��� all 4 tests

- [ ] **Step 11: Commit**

```bash
git add src/tts/interface.ts src/tts/elevenlabs.ts test/tts-elevenlabs.test.ts
git commit -m "feat: add ElevenLabs TTS provider with voice cache support"
```

---

### Task 5: Provider Factory

**Files:**
- Create: `src/tts/factory.ts`
- Modify: `test/tts-openai.test.ts` (verify speed parameter passthrough)

- [ ] **Step 1: Create provider factory**

Create `src/tts/factory.ts`:

```typescript
import type { TTSProvider } from './interface.js';
import type { ApiKeys } from '../config.js';
import { OpenAITTSProvider } from './openai.js';
import { ElevenLabsTTSProvider } from './elevenlabs.js';

export function createProvider(providerName: string, apiKeys: ApiKeys): TTSProvider {
  switch (providerName) {
    case 'openai': {
      if (!apiKeys.openai) {
        throw new Error('OpenAI API key not found. Set OPENAI_API_KEY or configure via plugin settings.');
      }
      return new OpenAITTSProvider(apiKeys.openai);
    }
    case 'elevenlabs': {
      if (!apiKeys.elevenlabs) {
        throw new Error('ElevenLabs API key not found. Add `export ELEVENLABS_API_KEY=xi-...` to ~/.claude-speak/env');
      }
      return new ElevenLabsTTSProvider(apiKeys.elevenlabs);
    }
    default:
      throw new Error(`Unknown TTS provider: ${providerName}. Supported providers: openai, elevenlabs`);
  }
}
```

- [ ] **Step 2: Run all existing TTS tests to verify nothing broke**

Run: `npx vitest run test/tts-openai.test.ts test/tts-elevenlabs.test.ts`
Expected: PASS — all tests still passing

- [ ] **Step 3: Commit**

```bash
git add src/tts/factory.ts
git commit -m "feat: add provider factory for creating TTS providers by name"
```

---

### Task 6: Subcommand Dispatcher

**Files:**
- Create: `src/subcommands.ts`
- Create: `test/subcommands.test.ts`

- [ ] **Step 1: Write subcommand tests**

Create `test/subcommands.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dispatch } from '../src/subcommands.js';
import * as config from '../src/config.js';
import * as session from '../src/session.js';
import * as voiceCache from '../src/voice-cache.js';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('../src/config.js');
vi.mock('../src/session.js');
vi.mock('../src/voice-cache.js');
vi.mock('node:fs');
vi.mock('node:os');

function makeConfig(overrides: Partial<config.VoiceConfig> = {}): config.VoiceConfig {
  return {
    enabled: true,
    activeProvider: 'openai',
    providers: {
      openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'Marin', speed: 1.2 },
    },
    apiKeys: { openai: 'sk-test', elevenlabs: null },
    hooks: { stop: true, notification: true },
    playback: { command: 'afplay' },
    cooldown: 10,
    timeout: 30,
    logFile: '/tmp/voice.log',
    ...overrides,
  };
}

describe('subcommands', () => {
  const mockHome = '/mock/home';

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig());
    vi.mocked(config.getConfigPath).mockReturnValue('/mock/home/.claude-speak.json');
    vi.mocked(session.loadSession).mockReturnValue({ muted: false });
    vi.mocked(session.writeSession).mockReturnValue(undefined);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      activeProvider: 'openai',
      providers: { openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'Marin', speed: 1.2 } },
      hooks: { stop: true, notification: true },
      playback: { command: 'afplay' },
      cooldown: 10,
      timeout: 30,
      logFile: '~/.claude-speak/logs/voice.log',
    }));
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('mute', () => {
    it('writes muted state to session', async () => {
      const result = await dispatch('mute', []);
      expect(session.writeSession).toHaveBeenCalledWith({ muted: true });
      expect(result.message).toContain('muted');
      expect(result.speak).toBe(false);
    });
  });

  describe('unmute', () => {
    it('clears muted state from session', async () => {
      vi.mocked(session.loadSession).mockReturnValue({ muted: true });
      const result = await dispatch('unmute', []);
      expect(session.writeSession).toHaveBeenCalledWith({ muted: false });
      expect(result.message).toContain('unmuted');
      expect(result.speak).toBe(true);
    });
  });

  describe('provider', () => {
    it('switches to a valid provider with API key', async () => {
      vi.mocked(config.loadConfig).mockReturnValue(makeConfig({
        apiKeys: { openai: 'sk-test', elevenlabs: 'xi-test' },
        providers: {
          openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'Marin', speed: 1.2 },
          elevenlabs: { model: 'eleven_multilingual_v2', voice: 'Rachel', speed: 1.0 },
        },
      }));
      const result = await dispatch('provider', ['elevenlabs']);
      expect(result.message).toContain('elevenlabs');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('rejects provider without API key', async () => {
      const result = await dispatch('provider', ['elevenlabs']);
      expect(result.message).toContain('API key not found');
      expect(result.error).toBe(true);
    });

    it('rejects unknown provider', async () => {
      const result = await dispatch('provider', ['azure']);
      expect(result.message).toContain('Unknown provider');
      expect(result.error).toBe(true);
    });
  });

  describe('speed', () => {
    it('updates speed in config for active provider', async () => {
      const result = await dispatch('speed', ['1.5']);
      expect(result.message).toContain('1.5');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('rejects out-of-range speed', async () => {
      const result = await dispatch('speed', ['5.0']);
      expect(result.message).toContain('between 0.25 and 4.0');
      expect(result.error).toBe(true);
    });

    it('rejects non-numeric speed', async () => {
      const result = await dispatch('speed', ['fast']);
      expect(result.error).toBe(true);
    });
  });

  describe('voice', () => {
    it('updates voice for OpenAI provider', async () => {
      const result = await dispatch('voice', ['nova']);
      expect(result.message).toContain('nova');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('rejects unknown OpenAI voice', async () => {
      const result = await dispatch('voice', ['nonexistent']);
      expect(result.message).toContain('Unknown voice');
      expect(result.error).toBe(true);
    });
  });

  describe('status', () => {
    it('returns current state summary', async () => {
      const result = await dispatch('status', []);
      expect(result.message).toContain('openai');
      expect(result.message).toContain('Marin');
      expect(result.message).toContain('1.2');
      expect(result.message).toContain('no'); // not muted
    });
  });

  describe('voices', () => {
    it('lists OpenAI voices', async () => {
      const result = await dispatch('voices', []);
      expect(result.message).toContain('alloy');
      expect(result.message).toContain('marin');
      expect(result.message).toContain('verse');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/subcommands.test.ts`
Expected: FAIL — module `../src/subcommands.js` does not exist

- [ ] **Step 3: Implement subcommands module**

Create `src/subcommands.ts`:

```typescript
import * as fs from 'node:fs';
import * as os from 'node:os';
import { loadConfig, getConfigPath, PROVIDER_DEFAULTS } from './config.js';
import { loadSession, writeSession } from './session.js';
import { readCache, fetchElevenLabsVoices, writeCache, resolveVoiceName } from './voice-cache.js';

export interface SubcommandResult {
  message: string;
  speak: boolean;
  error?: boolean;
}

const OPENAI_VOICES = [
  'alloy', 'ash', 'ballad', 'cedar', 'coral',
  'echo', 'fable', 'marin', 'nova', 'onyx',
  'sage', 'shimmer', 'verse',
];

const SUPPORTED_PROVIDERS = ['openai', 'elevenlabs'];

function updateConfigFile(updater: (config: Record<string, unknown>) => void): void {
  const configPath = getConfigPath();
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  updater(config);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export async function dispatch(cmd: string, args: string[]): Promise<SubcommandResult> {
  switch (cmd) {
    case 'mute':
      return cmdMute();
    case 'unmute':
      return cmdUnmute();
    case 'provider':
      return cmdProvider(args[0]);
    case 'speed':
      return cmdSpeed(args[0]);
    case 'voice':
      return cmdVoice(args[0]);
    case 'voices':
      return cmdVoices();
    case 'status':
      return cmdStatus();
    case 'test':
      return cmdTest();
    default:
      return { message: `Unknown subcommand: ${cmd}. Available: mute, unmute, provider, speed, voice, voices, status, test`, speak: false, error: true };
  }
}

function cmdMute(): SubcommandResult {
  const session = loadSession();
  session.muted = true;
  writeSession(session);
  return { message: 'Voice output muted for this session.', speak: false };
}

function cmdUnmute(): SubcommandResult {
  const session = loadSession();
  session.muted = false;
  writeSession(session);
  return { message: 'Voice output unmuted.', speak: true };
}

function cmdProvider(name: string | undefined): SubcommandResult {
  if (!name) {
    return { message: 'Usage: /speak: provider [openai|elevenlabs]', speak: false, error: true };
  }
  if (!SUPPORTED_PROVIDERS.includes(name)) {
    return { message: `Unknown provider: ${name}. Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`, speak: false, error: true };
  }

  const config = loadConfig();
  const apiKey = config.apiKeys[name as keyof typeof config.apiKeys];
  if (!apiKey) {
    const envVar = name === 'openai' ? 'OPENAI_API_KEY' : 'ELEVENLABS_API_KEY';
    return { message: `${name} API key not found. Add \`export ${envVar}=...\` to ~/.claude-speak/env`, speak: false, error: true };
  }

  updateConfigFile((cfg) => {
    cfg.activeProvider = name;
    // Create provider block with defaults if it doesn't exist
    const providers = (cfg.providers ?? {}) as Record<string, unknown>;
    if (!providers[name]) {
      providers[name] = { ...(PROVIDER_DEFAULTS[name] ?? PROVIDER_DEFAULTS.openai) };
    }
    cfg.providers = providers;
  });

  return { message: `Switched to ${name}.`, speak: false };
}

function cmdSpeed(value: string | undefined): SubcommandResult {
  if (!value) {
    return { message: 'Usage: /speak: speed [0.25-4.0]', speak: false, error: true };
  }
  const speed = parseFloat(value);
  if (isNaN(speed)) {
    return { message: `Invalid speed value: ${value}. Must be a number.`, speak: false, error: true };
  }
  if (speed < 0.25 || speed > 4.0) {
    return { message: 'Speed must be between 0.25 and 4.0.', speak: false, error: true };
  }

  const config = loadConfig();
  updateConfigFile((cfg) => {
    const providers = cfg.providers as Record<string, Record<string, unknown>>;
    if (providers[config.activeProvider]) {
      providers[config.activeProvider].speed = speed;
    }
  });

  return { message: `Speed set to ${speed}.`, speak: false };
}

function cmdVoice(name: string | undefined): SubcommandResult {
  if (!name) {
    return { message: 'Usage: /speak: voice [name]', speak: false, error: true };
  }

  const config = loadConfig();
  const providerName = config.activeProvider;

  if (providerName === 'openai') {
    if (!OPENAI_VOICES.includes(name.toLowerCase())) {
      return { message: `Unknown voice: ${name}. Run /speak: voices to see available options.`, speak: false, error: true };
    }
    updateConfigFile((cfg) => {
      const providers = cfg.providers as Record<string, Record<string, unknown>>;
      providers.openai.voice = name;
    });
    return { message: `Voice set to ${name}.`, speak: false };
  }

  if (providerName === 'elevenlabs') {
    const cache = readCache();
    let voiceId: string | null = null;
    if (cache) {
      voiceId = resolveVoiceName(name, cache.voices);
    }

    updateConfigFile((cfg) => {
      const providers = cfg.providers as Record<string, Record<string, unknown>>;
      providers.elevenlabs.voice = name;
      if (voiceId) {
        providers.elevenlabs.voiceId = voiceId;
      } else {
        // Treat as raw voice ID
        providers.elevenlabs.voiceId = name;
      }
    });

    if (voiceId) {
      return { message: `Voice set to ${name} (${voiceId}).`, speak: false };
    }
    return { message: `Voice set to ${name}. No cache match found — treating as voice ID.`, speak: false };
  }

  return { message: `Voice switching not supported for provider: ${providerName}`, speak: false, error: true };
}

async function cmdVoices(): Promise<SubcommandResult> {
  const config = loadConfig();

  if (config.activeProvider === 'openai') {
    const list = OPENAI_VOICES.join(', ');
    return { message: `Available voices (OpenAI):\n  ${list}`, speak: false };
  }

  if (config.activeProvider === 'elevenlabs') {
    const apiKey = config.apiKeys.elevenlabs;
    if (!apiKey) {
      return { message: 'ElevenLabs API key not found. Cannot fetch voices.', speak: false, error: true };
    }
    try {
      const voices = await fetchElevenLabsVoices(apiKey);
      writeCache(voices);
      const lines = voices.map((v) => `  ${v.name.padEnd(20)} ${v.category.padEnd(12)} ${v.voiceId}`);
      return { message: `Available voices (ElevenLabs) — fetched just now:\n${lines.join('\n')}`, speak: false };
    } catch (err) {
      return { message: `Failed to fetch voices: ${err instanceof Error ? err.message : String(err)}`, speak: false, error: true };
    }
  }

  return { message: `Voice listing not supported for provider: ${config.activeProvider}`, speak: false, error: true };
}

function cmdStatus(): SubcommandResult {
  const config = loadConfig();
  const session = loadSession();
  const provider = config.providers[config.activeProvider];

  const lines = [
    `Provider: ${config.activeProvider}`,
    `Voice: ${provider?.voice || '(not set)'}`,
    `Speed: ${provider?.speed ?? 1.0}`,
    `Muted: ${session.muted ? 'yes' : 'no'}`,
    `Hooks: stop (${config.hooks.stop ? 'on' : 'off'}) notification (${config.hooks.notification ? 'on' : 'off'})`,
  ];

  return { message: lines.join('\n'), speak: false };
}

function cmdTest(): SubcommandResult {
  const config = loadConfig();
  const provider = config.providers[config.activeProvider];
  const providerLabel = config.activeProvider.charAt(0).toUpperCase() + config.activeProvider.slice(1);
  const text = `Voice check. Provider: ${providerLabel}. Voice: ${provider?.voice || 'default'}. Speed: ${provider?.speed ?? 1.0}.`;
  return { message: text, speak: true };
}
```

- [ ] **Step 4: Run subcommand tests to verify they pass**

Run: `npx vitest run test/subcommands.test.ts`
Expected: PASS — all 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/subcommands.ts test/subcommands.test.ts
git commit -m "feat: add subcommand dispatcher for mute, unmute, provider, speed, voice, voices, status, test"
```

---

### Task 7: Update CLI Entry Point

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write new CLI tests for mute and --cmd routing**

Add tests to `test/cli.test.ts`. The existing mocks need updating since `config.VoiceConfig` changed. Replace the entire file:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { run, isIdleNotification } from '../src/cli.js';
import * as config from '../src/config.js';
import * as session from '../src/session.js';
import * as extractor from '../src/extractor.js';
import * as sanitizer from '../src/sanitizer.js';
import * as lock from '../src/lock.js';
import * as player from '../src/player.js';
import * as error from '../src/error.js';
import * as subcommands from '../src/subcommands.js';

vi.mock('../src/config.js');
vi.mock('../src/session.js');
vi.mock('../src/extractor.js');
vi.mock('../src/sanitizer.js');
vi.mock('../src/lock.js');
vi.mock('../src/player.js');
vi.mock('../src/error.js');
vi.mock('../src/subcommands.js');

// Mock the TTS provider factory
const mockSynthesize = vi.fn();
vi.mock('../src/tts/factory.js', () => ({
  createProvider: () => ({ synthesize: mockSynthesize }),
}));

function makeConfig(overrides: Partial<config.VoiceConfig> = {}): config.VoiceConfig {
  return {
    enabled: true,
    activeProvider: 'openai',
    providers: {
      openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'ash', speed: 1.0 },
    },
    apiKeys: { openai: 'sk-test', elevenlabs: null },
    hooks: { stop: true, notification: true },
    playback: { command: 'afplay' },
    cooldown: 15,
    timeout: 30,
    logFile: '/tmp/voice.log',
    ...overrides,
  };
}

describe('CLI run', () => {
  beforeEach(() => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig());
    vi.mocked(session.loadSession).mockReturnValue({ muted: false });
    vi.mocked(sanitizer.sanitize).mockImplementation((t) => t);
    vi.mocked(lock.isLocked).mockReturnValue(false);
    vi.mocked(lock.writeLock).mockReturnValue(undefined);
    vi.mocked(player.playAudio).mockReturnValue(undefined);
    vi.mocked(error.handleError).mockReturnValue(undefined);
    mockSynthesize.mockResolvedValue(Buffer.from('audio'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits immediately when voice is disabled', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({ enabled: false }));
    await run(['--trigger', 'stop'], '');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('exits silently when muted', async () => {
    vi.mocked(session.loadSession).mockReturnValue({ muted: true });
    await run(['--say', 'Hello'], '');
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(lock.writeLock).not.toHaveBeenCalled();
  });

  it('exits silently when muted on passive voice', async () => {
    vi.mocked(session.loadSession).mockReturnValue({ muted: true });
    vi.mocked(extractor.extractMessage).mockReturnValue('Some message');
    await run(['--trigger', 'stop'], '{}');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('dispatches --cmd to subcommand handler', async () => {
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: 'Muted.', speak: false });
    await run(['--cmd', 'mute'], '');
    expect(subcommands.dispatch).toHaveBeenCalledWith('mute', []);
  });

  it('dispatches --cmd with arguments', async () => {
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: 'Speed set.', speak: false });
    await run(['--cmd', 'speed', '1.5'], '');
    expect(subcommands.dispatch).toHaveBeenCalledWith('speed', ['1.5']);
  });

  it('processes --say argument through the pipeline', async () => {
    await run(['--say', 'Hello world'], '');
    expect(sanitizer.sanitize).toHaveBeenCalledWith('Hello world');
    expect(mockSynthesize).toHaveBeenCalled();
    expect(player.playAudio).toHaveBeenCalled();
  });

  it('writes lock when using --say (active voice)', async () => {
    await run(['--say', 'Hello'], '');
    expect(lock.writeLock).toHaveBeenCalled();
  });

  it('processes --trigger by extracting from stdin', async () => {
    const stdinData = JSON.stringify({
      message: { role: 'assistant', content: 'Done with the task.' },
    });
    vi.mocked(extractor.extractMessage).mockReturnValue('Done with the task.');
    await run(['--trigger', 'stop'], stdinData);
    expect(extractor.extractMessage).toHaveBeenCalledWith(stdinData);
    expect(mockSynthesize).toHaveBeenCalled();
  });

  it('skips passive voice when lock is active', async () => {
    vi.mocked(lock.isLocked).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('Some message');
    await run(['--trigger', 'stop'], '{}');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('skips when hook type is disabled in config', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({
      hooks: { stop: false, notification: true },
    }));
    vi.mocked(extractor.extractMessage).mockReturnValue('Some message');
    await run(['--trigger', 'stop'], '{}');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('calls error handler on TTS failure', async () => {
    mockSynthesize.mockRejectedValue(new Error('API down'));
    await run(['--say', 'Hello'], '');
    expect(error.handleError).toHaveBeenCalledWith(expect.any(Error), expect.any(String));
  });

  it('exits when no API key is configured for active provider', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({ apiKeys: { openai: null, elevenlabs: null } }));
    await run(['--say', 'Hello'], '');
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(error.handleError).toHaveBeenCalled();
  });

  it('filters idle notifications on notification trigger', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('Claude is waiting for your input');
    await run(['--trigger', 'notification'], '{}');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('allows non-idle notifications on notification trigger', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('Build completed successfully');
    await run(['--trigger', 'notification'], '{}');
    expect(mockSynthesize).toHaveBeenCalled();
  });

  it('does not filter idle-like text on stop trigger', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('I am waiting for your input on the design.');
    await run(['--trigger', 'stop'], '{}');
    expect(mockSynthesize).toHaveBeenCalled();
  });
});

describe('isIdleNotification', () => {
  it.each([
    'Claude is waiting for your input',
    'Waiting for input',
    'waiting for your response',
    'Ready for your next input',
    'Awaiting your input',
    'Claude is waiting for input.',
  ])('detects idle notification: %s', (text) => {
    expect(isIdleNotification(text)).toBe(true);
  });

  it.each([
    'I need your input on the database schema',
    'Build completed successfully',
    'The tests are waiting to be reviewed',
    'I updated the config file',
  ])('allows legitimate message: %s', (text) => {
    expect(isIdleNotification(text)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — new imports and mocks not yet wired up in cli.ts

- [ ] **Step 3: Rewrite cli.ts with mute check, --cmd routing, and provider factory**

Replace `src/cli.ts`:

```typescript
import { loadConfig } from './config.js';
import { loadSession } from './session.js';
import { extractMessage } from './extractor.js';
import { sanitize } from './sanitizer.js';
import { createProvider } from './tts/factory.js';
import { playAudio } from './player.js';
import { writeLock, isLocked } from './lock.js';
import { handleError } from './error.js';
import { dispatch } from './subcommands.js';
import * as path from 'node:path';

const DEBUG = process.env.CLAUDE_SPEAK_DEBUG === '1';
function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[claude-speak] ${msg}\n`);
}

export async function run(args: string[], stdin: string): Promise<void> {
  const config = loadConfig();
  debug(`enabled=${config.enabled} activeProvider=${config.activeProvider} args=${JSON.stringify(args)}`);

  if (!config.enabled) { debug('EXIT: disabled'); return; }

  // Check mute state early — before any TTS work
  const session = loadSession();
  if (session.muted) {
    // Exception: allow --cmd through so user can unmute
    const cmdIndex = args.indexOf('--cmd');
    if (cmdIndex === -1) {
      debug('EXIT: muted');
      return;
    }
  }

  const sayIndex = args.indexOf('--say');
  const triggerIndex = args.indexOf('--trigger');
  const cmdIndex = args.indexOf('--cmd');

  // Subcommand mode
  if (cmdIndex !== -1 && args[cmdIndex + 1]) {
    const subCmd = args[cmdIndex + 1];
    const subArgs = args.slice(cmdIndex + 2);
    const result = await dispatch(subCmd, subArgs);
    // Output message to stdout for Claude to see
    if (result.message) {
      process.stdout.write(result.message + '\n');
    }
    // If the subcommand wants to speak (e.g., unmute confirmation, test)
    if (result.speak && result.message) {
      await speakText(result.message, config);
    }
    return;
  }

  // Mute check for non-cmd paths (already checked above, but be explicit)
  if (session.muted) { debug('EXIT: muted'); return; }

  let text: string | null = null;
  let isActiveVoice = false;

  if (sayIndex !== -1 && args[sayIndex + 1]) {
    writeLock(getLockPath());
    text = args[sayIndex + 1];
    isActiveVoice = true;
  } else if (triggerIndex !== -1 && args[triggerIndex + 1]) {
    const triggerType = args[triggerIndex + 1] as 'stop' | 'notification';
    if (!config.hooks[triggerType]) return;
    const lockPath = getLockPath();
    debug(`lockPath=${lockPath} cooldown=${config.cooldown} locked=${isLocked(lockPath, config.cooldown)}`);
    if (isLocked(lockPath, config.cooldown)) { debug('EXIT: locked by active voice'); return; }
    text = extractMessage(stdin);
    debug(`extracted text=${text ? text.slice(0, 100) : 'null'}`);
    if (triggerType === 'notification' && text && isIdleNotification(text)) {
      debug('EXIT: filtered idle notification');
      return;
    }
  } else {
    debug('EXIT: no valid args');
    return;
  }

  if (!text) { debug('EXIT: no text'); return; }

  const sanitized = sanitize(text);
  if (!sanitized) return;

  await speakText(sanitized, config);

  if (isActiveVoice) {
    writeLock(getLockPath());
  }
}

async function speakText(text: string, config: ReturnType<typeof loadConfig>): Promise<void> {
  const activeProvider = config.providers[config.activeProvider];
  if (!activeProvider) {
    handleError(new Error(`No configuration found for provider: ${config.activeProvider}`), config.logFile);
    return;
  }

  const apiKey = config.apiKeys[config.activeProvider as keyof typeof config.apiKeys];
  if (!apiKey) {
    handleError(new Error(`No API key configured for ${config.activeProvider}. Check ~/.claude-speak/env`), config.logFile);
    return;
  }

  try {
    const provider = createProvider(config.activeProvider, config.apiKeys);
    const audio = await provider.synthesize(text, {
      voice: activeProvider.voice,
      voiceId: activeProvider.voiceId,
      model: activeProvider.model,
      instructions: activeProvider.instructions || undefined,
      speed: activeProvider.speed,
      stability: activeProvider.stability,
      similarityBoost: activeProvider.similarityBoost,
      style: activeProvider.style,
    });
    playAudio(audio, config.playback.command);
  } catch (err) {
    debug(`TTS ERROR: ${err instanceof Error ? err.message : String(err)}`);
    handleError(err, config.logFile);
  }
}

const IDLE_NOTIFICATION_PATTERNS = [
  /waiting\s+for\s+(your\s+)?input/i,
  /waiting\s+for\s+(your\s+)?response/i,
  /ready\s+for\s+(your\s+)?(next\s+)?input/i,
  /awaiting\s+(your\s+)?input/i,
];

export function isIdleNotification(text: string): boolean {
  return IDLE_NOTIFICATION_PATTERNS.some((pattern) => pattern.test(text));
}

function getLockPath(): string {
  return path.join(process.env.HOME || '', '.claude-speak', 'voice.lock');
}

// Main execution when run as script
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainModule) {
  let stdin = '';
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    stdin = Buffer.concat(chunks).toString('utf-8');
  }
  run(process.argv.slice(2), stdin).catch((err) => {
    console.error('claude-speak fatal:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run CLI tests to verify they pass**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS — all 15 tests

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all tests across all files

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: update CLI with mute check, --cmd routing, and provider factory"
```

---

### Task 8: Update Plugin Artifacts

**Files:**
- Modify: `claude-speak.example.json`
- Modify: `skills/speak/SKILL.md`
- Modify: `scripts/check-setup.sh`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update example config**

Replace `claude-speak.example.json`:

```json
{
  "activeProvider": "openai",
  "providers": {
    "openai": {
      "model": "gpt-4o-mini-tts-2025-12-15",
      "voice": "Marin",
      "instructions": "Speak in a cheeky, conversational tone. Be direct and concise.",
      "speed": 1.0
    },
    "elevenlabs": {
      "model": "eleven_multilingual_v2",
      "voice": "",
      "stability": 0.5,
      "similarityBoost": 0.75,
      "style": 0.0,
      "speed": 1.0
    }
  },
  "hooks": {
    "stop": true,
    "notification": true
  },
  "playback": {
    "command": "afplay"
  },
  "cooldown": 10,
  "timeout": 30,
  "logFile": "~/.claude-speak/logs/voice.log"
}
```

- [ ] **Step 2: Update SKILL.md with subcommand documentation**

Replace `skills/speak/SKILL.md`:

````markdown
---
name: speak
description: Speak to the user audibly through text-to-speech. Use when the user may not be watching the screen and something warrants their audible attention. This is NOT the built-in Claude Code voice mode — this uses the claude-speak plugin to generate speech via TTS.
---

# Voice Output

You have the ability to speak to the user audibly using text-to-speech.

## How to invoke

The plugin root is derived from this skill's base directory (two levels up). When Claude Code loads this skill it prints a line like `Base directory for this skill: /path/to/skills/speak`. Use that path to build the CLI path below.

### Active voice (speak a message)

Run these two commands in sequence via the Bash tool:

**Step 1 — Write the lock (must run first, in its own Bash call):**
```bash
mkdir -p ~/.claude-speak && date +%s000 > ~/.claude-speak/voice.lock
```

**Step 2 — Speak (separate Bash call, after step 1 completes):**
```bash
node "<SKILL_BASE_DIR>/../../dist/cli.js" --say "<your message here>"
```

Replace `<SKILL_BASE_DIR>` with the base directory shown when this skill was loaded. Replace `<your message here>` with the exact text you want spoken.

IMPORTANT: Always run step 1 before step 2. Never combine them into one command.

### Subcommands

Subcommands are invoked with `--cmd` instead of `--say`. No lock file is needed for subcommands.

```bash
node "<SKILL_BASE_DIR>/../../dist/cli.js" --cmd <subcommand> [args]
```

| User invocation | CLI command | Effect |
|---|---|---|
| `/speak: mute` | `--cmd mute` | Mute all TTS for this session |
| `/speak: unmute` | `--cmd unmute` | Re-enable TTS (speaks confirmation) |
| `/speak: provider openai` | `--cmd provider openai` | Switch active TTS provider (persistent) |
| `/speak: provider elevenlabs` | `--cmd provider elevenlabs` | Switch active TTS provider (persistent) |
| `/speak: voice Marin` | `--cmd voice Marin` | Change voice (persistent) |
| `/speak: voices` | `--cmd voices` | List available voices for current provider |
| `/speak: speed 1.2` | `--cmd speed 1.2` | Change speed (persistent, range 0.25-4.0) |
| `/speak: status` | `--cmd status` | Show current state (provider, voice, speed, mute) |
| `/speak: test` | `--cmd test` | Speak a diagnostic phrase |

**Routing rule:** If the argument after `/speak:` matches a subcommand keyword (mute, unmute, provider, voice, voices, speed, status, test), run it as `--cmd`. Otherwise, treat it as active voice and run it as `--say`.

## When to use active voice

- **Critical failures** — a build broke, a deploy failed, a test suite collapsed
- **Blocking decisions** — you need the user's input before you can continue
- **Completed milestones** — a long-running task finished successfully
- **Security or data concerns** — something the user must know about immediately
- **The user may not be watching** — any information important enough that it shouldn't wait for the user to glance at the screen

## When NOT to use active voice

- **Routine status updates** — the passive voice hook already speaks your final message at the end of each turn
- **Acknowledging commands** — don't say "Got it" or "Working on it"
- **Information only useful on screen** — code diffs, file contents, long lists
- **Anything the end-of-turn hook will cover** — if you're about to finish your turn, don't duplicate the message

## Writing for the ear

- Keep it under 2-3 sentences
- Use natural speech patterns, not written prose
- Front-load the important information
- Avoid technical jargon unless the user will understand it in context
- No markdown formatting — the sanitizer strips it, but write clean text from the start
````

- [ ] **Step 3: Update check-setup.sh to clean session on start and check for either API key**

Replace `scripts/check-setup.sh`:

```bash
#!/bin/bash
# check-setup.sh — Runs on SessionStart to verify claude-speak is configured.
# Outputs setup instructions as additionalContext if config is missing.
# API keys are NEVER prompted for within Claude Code — users set them manually.

CONFIG_FILE="$HOME/.claude-speak.json"
ENV_FILE="$HOME/.claude-speak/env"
SESSION_FILE="$HOME/.claude-speak/session.json"
EXAMPLE_CONFIG="${CLAUDE_PLUGIN_ROOT}/claude-speak.example.json"
HAS_ISSUES=false
ISSUES=""

# Clean session state from previous session (fresh start)
rm -f "$SESSION_FILE"

# Check for env file with at least one API key
if [ ! -f "$ENV_FILE" ]; then
  # Fallback: check if any key is in the environment already
  if [ -z "$OPENAI_API_KEY" ] && [ -z "$CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY" ] && [ -z "$ELEVENLABS_API_KEY" ] && [ -z "$CLAUDE_PLUGIN_OPTION_ELEVENLABS_API_KEY" ]; then
    HAS_ISSUES=true
    ISSUES="${ISSUES}\n- **API key not configured.** Create the file \`~/.claude-speak/env\` with at least one API key:\n  \`export OPENAI_API_KEY=sk-your-key-here\`\n  \`export ELEVENLABS_API_KEY=xi-your-key-here\`\n  This file is sourced by the voice hooks and keeps your keys out of Claude's context."
  fi
fi

# Check for config file
if [ ! -f "$CONFIG_FILE" ]; then
  HAS_ISSUES=true
  ISSUES="${ISSUES}\n- **Config file missing.** Run: \`cp ${EXAMPLE_CONFIG} ~/.claude-speak.json\` then edit ~/.claude-speak.json to set your voice, delivery instructions, and preferences."
fi

if [ "$HAS_ISSUES" = true ]; then
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "## claude-speak Plugin — Setup Required\n\nThe claude-speak plugin is installed but not fully configured:\n${ISSUES}\n\nIMPORTANT: Do NOT ask the user for their API key. Direct them to set it in ~/.claude-speak/env manually. Never handle API keys within a Claude Code session.\n\nOnce configured, restart Claude Code. Your responses will be spoken aloud automatically, and you can use the speak skill to speak deliberately during a turn."
  }
}
EOF
else
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}'
fi
```

- [ ] **Step 4: Update CLAUDE.md with subcommand mention**

Replace `CLAUDE.md`:

```markdown
## Voice Output Capability

This Claude Code session has voice output enabled via the claude-speak plugin.

### Passive Voice (automatic)
Your final message at the end of each turn is automatically spoken aloud to the user via text-to-speech. You do not need to do anything for this to work. Write your final messages knowing they may be heard as well as read.

### Active Voice (deliberate)
You can also choose to speak to the user at any point during your turn using the `speak` skill. Use this when something is important enough to warrant the user's immediate audible attention, even if they are not watching the screen.

Invoke it by using the Skill tool with `speak` and providing your message as the argument. The skill will provide the exact commands to run.

### Subcommands
The speak skill also supports subcommands for session control:
- `/speak: mute` and `/speak: unmute` — toggle voice output for the current session
- `/speak: provider [name]` — switch between TTS providers (openai, elevenlabs)
- `/speak: voice [name]` — change the speaking voice
- `/speak: speed [value]` — adjust speaking speed (0.25-4.0)
- `/speak: status` — show current voice configuration
- `/speak: test` — speak a diagnostic phrase
- `/speak: voices` ��� list available voices for the current provider

### Guidelines
- Do not overuse active voice. If your end-of-turn message will cover it, let the passive hook handle it.
- When you use active voice, write for the ear: short, direct, natural speech.
- The user has configured a personality and tone for TTS delivery. Your text carries the content and meaning; the TTS system handles vocal delivery.
- A cooldown prevents speaking too frequently. If your active voice call is silently skipped, it means you spoke recently — this is expected behavior.
- If the user mutes voice output, respect it. Do not attempt to speak until they unmute.
```

- [ ] **Step 5: Update hooks.json to source env for both API keys**

The hooks already source `~/.claude-speak/env` which will now contain both keys. No change needed to `hooks/hooks.json` since the env file approach handles both keys naturally.

- [ ] **Step 6: Commit**

```bash
git add claude-speak.example.json skills/speak/SKILL.md scripts/check-setup.sh CLAUDE.md
git commit -m "feat: update plugin artifacts for multi-provider and subcommand support"
```

---

### Task 9: Build and Integration Test

**Files:**
- Modify: `dist/cli.js` (rebuilt)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all tests across all files

- [ ] **Step 2: Run type checker**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Build the bundle**

Run: `npm run build`
Expected: `dist/cli.js` generated without errors

- [ ] **Step 4: Smoke test — status subcommand**

Run: `node dist/cli.js --cmd status`
Expected: Outputs provider, voice, speed, muted state, hooks

- [ ] **Step 5: Smoke test — mute/unmute**

Run: `node dist/cli.js --cmd mute`
Expected: Outputs "Voice output muted for this session."

Run: `node dist/cli.js --cmd unmute`
Expected: Outputs "Voice output unmuted." and speaks confirmation.

- [ ] **Step 6: Smoke test — voices**

Run (with API key sourced): `source ~/.claude-speak/env && node dist/cli.js --cmd voices`
Expected: Lists available voices for the active provider.

- [ ] **Step 7: Commit the build**

```bash
git add dist/cli.js
git commit -m "chore: rebuild dist/cli.js for multi-provider and subcommand support"
```

---

### Task 10: Version Bump and Final Commit

**Files:**
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Bump version to 1.1.0**

In `package.json`, change `"version": "1.0.1"` to `"version": "1.1.0"`.

In `.claude-plugin/plugin.json`, change `"version": "1.0.1"` to `"version": "1.1.0"`.

- [ ] **Step 2: Commit version bump**

```bash
git add package.json .claude-plugin/plugin.json
git commit -m "chore: bump version to 1.1.0 for multi-provider and subcommand features"
```

- [ ] **Step 3: Run final full test suite**

Run: `npx vitest run`
Expected: PASS — all tests
