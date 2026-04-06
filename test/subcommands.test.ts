import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VoiceConfig } from '../src/config.js';
import type { SessionState } from '../src/session.js';
import type { VoiceCacheEntry } from '../src/voice-cache.js';

// Mock all dependencies
vi.mock('../src/config.js');
vi.mock('../src/session.js');
vi.mock('../src/voice-cache.js');
vi.mock('node:fs');
vi.mock('node:os');

function makeConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    enabled: true,
    activeProvider: 'openai',
    providers: {
      openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'ash', speed: 1.0 },
      elevenlabs: { model: 'eleven_multilingual_v2', voice: 'Rachel', speed: 1.0, stability: 0.5, similarityBoost: 0.75, style: 0.0 },
    },
    apiKeys: { openai: 'sk-test-key', elevenlabs: 'el-test-key' },
    hooks: { stop: true, notification: true },
    playback: { command: 'afplay' },
    cooldown: 15,
    timeout: 30,
    logFile: '/mock/home/.claude-speak/logs/voice.log',
    ...overrides,
  };
}

describe('subcommand dispatcher', () => {
  let mockLoadConfig: ReturnType<typeof vi.fn>;
  let mockGetConfigPath: ReturnType<typeof vi.fn>;
  let mockLoadSession: ReturnType<typeof vi.fn>;
  let mockWriteSession: ReturnType<typeof vi.fn>;
  let mockReadCache: ReturnType<typeof vi.fn>;
  let mockWriteCache: ReturnType<typeof vi.fn>;
  let mockResolveVoiceName: ReturnType<typeof vi.fn>;
  let mockFetchElevenLabsVoices: ReturnType<typeof vi.fn>;
  let mockFs: { readFileSync: ReturnType<typeof vi.fn>; writeFileSync: ReturnType<typeof vi.fn>; existsSync: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();

    const configMod = await import('../src/config.js');
    mockLoadConfig = vi.mocked(configMod.loadConfig);
    mockGetConfigPath = vi.mocked(configMod.getConfigPath);
    mockGetConfigPath.mockReturnValue('/mock/home/.claude-speak.json');

    const sessionMod = await import('../src/session.js');
    mockLoadSession = vi.mocked(sessionMod.loadSession);
    mockWriteSession = vi.mocked(sessionMod.writeSession);

    const cacheMod = await import('../src/voice-cache.js');
    mockReadCache = vi.mocked(cacheMod.readCache);
    mockWriteCache = vi.mocked(cacheMod.writeCache);
    mockResolveVoiceName = vi.mocked(cacheMod.resolveVoiceName);
    mockFetchElevenLabsVoices = vi.mocked(cacheMod.fetchElevenLabsVoices);

    const fsMod = await import('node:fs');
    mockFs = {
      readFileSync: vi.mocked(fsMod.readFileSync),
      writeFileSync: vi.mocked(fsMod.writeFileSync),
      existsSync: vi.mocked(fsMod.existsSync),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('mute', () => {
    it('writes muted state and returns speak: false', async () => {
      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('mute', []);
      expect(mockWriteSession).toHaveBeenCalledWith({ muted: true });
      expect(result.speak).toBe(false);
      expect(result.message).toContain('muted');
    });
  });

  describe('unmute', () => {
    it('clears muted state and returns speak: true', async () => {
      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('unmute', []);
      expect(mockWriteSession).toHaveBeenCalledWith({ muted: false });
      expect(result.speak).toBe(true);
      expect(result.message).toContain('unmuted');
    });
  });

  describe('provider', () => {
    it('switches to a valid provider with API key', async () => {
      const config = makeConfig();
      mockLoadConfig.mockReturnValue(config);
      const fileConfig = {
        activeProvider: 'openai',
        providers: { openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'ash', speed: 1.0 } },
      };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(fileConfig));
      mockFs.writeFileSync.mockReturnValue(undefined);

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('provider', ['elevenlabs']);
      expect(result.error).toBeUndefined();
      expect(result.message).toContain('elevenlabs');

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(written.activeProvider).toBe('elevenlabs');
    });

    it('rejects provider without API key', async () => {
      const config = makeConfig({ apiKeys: { openai: 'sk-test', elevenlabs: null } });
      mockLoadConfig.mockReturnValue(config);

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('provider', ['elevenlabs']);
      expect(result.error).toBe(true);
      expect(result.message).toContain('ELEVENLABS_API_KEY');
    });

    it('rejects unknown provider name', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('provider', ['azure']);
      expect(result.error).toBe(true);
      expect(result.message).toContain('openai');
      expect(result.message).toContain('elevenlabs');
    });
  });

  describe('speed', () => {
    it('updates speed in config', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());
      const fileConfig = {
        activeProvider: 'openai',
        providers: { openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'ash', speed: 1.0 } },
      };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(fileConfig));
      mockFs.writeFileSync.mockReturnValue(undefined);

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('speed', ['1.5']);
      expect(result.error).toBeUndefined();
      expect(result.message).toContain('1.5');

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(written.providers.openai.speed).toBe(1.5);
    });

    it('rejects out-of-range values', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('speed', ['5.0']);
      expect(result.error).toBe(true);
      expect(result.message).toContain('0.25');
      expect(result.message).toContain('4.0');
    });

    it('rejects non-numeric values', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('speed', ['fast']);
      expect(result.error).toBe(true);
    });
  });

  describe('voice', () => {
    it('updates voice for OpenAI with valid name', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());
      const fileConfig = {
        activeProvider: 'openai',
        providers: { openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'ash', speed: 1.0 } },
      };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(fileConfig));
      mockFs.writeFileSync.mockReturnValue(undefined);

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('voice', ['nova']);
      expect(result.error).toBeUndefined();
      expect(result.message).toContain('nova');

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(written.providers.openai.voice).toBe('nova');
    });

    it('rejects unknown OpenAI voice', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('voice', ['siri']);
      expect(result.error).toBe(true);
      expect(result.message).toContain('siri');
    });

    it('resolves ElevenLabs voice by name from cache', async () => {
      const config = makeConfig({ activeProvider: 'elevenlabs' });
      mockLoadConfig.mockReturnValue(config);
      const cache: VoiceCacheEntry[] = [
        { name: 'Rachel', voiceId: 'abc123', category: 'premade' },
      ];
      mockReadCache.mockReturnValue({ fetched: '2026-01-01', voices: cache });
      mockResolveVoiceName.mockReturnValue([{ voiceId: 'abc123', name: 'Rachel', matchType: 'exact' }]);
      const fileConfig = {
        activeProvider: 'elevenlabs',
        providers: { elevenlabs: { model: 'eleven_multilingual_v2', voice: 'Rachel', speed: 1.0 } },
      };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(fileConfig));
      mockFs.writeFileSync.mockReturnValue(undefined);

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('voice', ['Rachel']);
      expect(result.error).toBeUndefined();

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(written.providers.elevenlabs.voice).toBe('Rachel');
      expect(written.providers.elevenlabs.voiceId).toBe('abc123');
    });

    it('treats unresolved ElevenLabs voice as raw ID', async () => {
      const config = makeConfig({ activeProvider: 'elevenlabs' });
      mockLoadConfig.mockReturnValue(config);
      mockReadCache.mockReturnValue({ fetched: '2026-01-01', voices: [] });
      mockResolveVoiceName.mockReturnValue([]);
      const fileConfig = {
        activeProvider: 'elevenlabs',
        providers: { elevenlabs: { model: 'eleven_multilingual_v2', voice: '', speed: 1.0 } },
      };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(fileConfig));
      mockFs.writeFileSync.mockReturnValue(undefined);

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('voice', ['raw-voice-id-123']);
      expect(result.error).toBeUndefined();

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(written.providers.elevenlabs.voiceId).toBe('raw-voice-id-123');
    });
  });

  describe('voices', () => {
    it('lists OpenAI voices as static list', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('voices', []);
      expect(result.message).toContain('alloy');
      expect(result.message).toContain('shimmer');
      expect(result.message).toContain('verse');
      expect(result.error).toBeUndefined();
    });

    it('lists ElevenLabs voices by fetching', async () => {
      const config = makeConfig({ activeProvider: 'elevenlabs' });
      mockLoadConfig.mockReturnValue(config);
      const voices: VoiceCacheEntry[] = [
        { name: 'Rachel', voiceId: 'abc', category: 'premade' },
        { name: 'Adam', voiceId: 'def', category: 'cloned' },
      ];
      mockFetchElevenLabsVoices.mockResolvedValue(voices);
      mockWriteCache.mockReturnValue(undefined);

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('voices', []);
      expect(result.message).toContain('Rachel');
      expect(result.message).toContain('Adam');
      expect(mockWriteCache).toHaveBeenCalledWith(voices);
    });
  });

  describe('status', () => {
    it('returns current state summary', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());
      mockLoadSession.mockReturnValue({ muted: false } as SessionState);

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('status', []);
      expect(result.message).toContain('openai');
      expect(result.message).toContain('ash');
      expect(result.message).toContain('1');
      expect(result.speak).toBe(false);
    });
  });

  describe('test', () => {
    it('returns diagnostic phrase with speak: true', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('test', []);
      expect(result.speak).toBe(true);
      expect(result.message.length).toBeGreaterThan(0);
    });
  });

  describe('unknown command', () => {
    it('returns error with available commands', async () => {
      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('foobar', []);
      expect(result.error).toBe(true);
      expect(result.message).toContain('foobar');
      expect(result.message).toContain('mute');
      expect(result.message).toContain('unmute');
    });
  });
});
