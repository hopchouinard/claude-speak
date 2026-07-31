import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VoiceConfig } from '../src/config.js';
import type { VoiceCacheEntry } from '../src/voice-cache.js';
import * as session from '../src/session.js';
import * as player from '../src/player.js';

// Mock all dependencies
vi.mock('../src/config.js');
vi.mock('../src/session.js');
vi.mock('../src/player.js');
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
    speech: {
      maxChars: 500,
      condense: true,
      summarizer: { model: 'gpt-5.4-nano-2026-03-17', timeout: 8, maxWords: 40 },
    },
    cooldown: 15,
    timeout: 30,
    logFile: '/mock/home/.claude-speak/logs/voice.log',
    ...overrides,
  };
}

describe('subcommand dispatcher', () => {
  let mockLoadConfig: ReturnType<typeof vi.fn>;
  let mockGetConfigPath: ReturnType<typeof vi.fn>;
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
      const result = await dispatch('provider', ['elevenlabs'], 'sess-1');
      expect(result.error).toBeUndefined();
      expect(result.message).toContain('elevenlabs');

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(written.activeProvider).toBe('elevenlabs');
    });

    it('rejects provider without API key', async () => {
      const config = makeConfig({ apiKeys: { openai: 'sk-test', elevenlabs: null } });
      mockLoadConfig.mockReturnValue(config);

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('provider', ['elevenlabs'], 'sess-1');
      expect(result.error).toBe(true);
      expect(result.message).toContain('ELEVENLABS_API_KEY');
    });

    it('rejects unknown provider name', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('provider', ['azure'], 'sess-1');
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
      const result = await dispatch('speed', ['1.5'], 'sess-1');
      expect(result.error).toBeUndefined();
      expect(result.message).toContain('1.5');

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(written.providers.openai.speed).toBe(1.5);
    });

    it('rejects out-of-range values', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('speed', ['5.0'], 'sess-1');
      expect(result.error).toBe(true);
      expect(result.message).toContain('0.25');
      expect(result.message).toContain('4.0');
    });

    it('rejects non-numeric values', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('speed', ['fast'], 'sess-1');
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
      const result = await dispatch('voice', ['nova'], 'sess-1');
      expect(result.error).toBeUndefined();
      expect(result.message).toContain('nova');

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(written.providers.openai.voice).toBe('nova');
    });

    it('rejects unknown OpenAI voice', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('voice', ['siri'], 'sess-1');
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
      const result = await dispatch('voice', ['Rachel'], 'sess-1');
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
      const result = await dispatch('voice', ['raw-voice-id-123'], 'sess-1');
      expect(result.error).toBeUndefined();

      const written = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(written.providers.elevenlabs.voiceId).toBe('raw-voice-id-123');
    });
  });

  describe('voices', () => {
    it('lists OpenAI voices as static list', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('voices', [], 'sess-1');
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
      const result = await dispatch('voices', [], 'sess-1');
      expect(result.message).toContain('Rachel');
      expect(result.message).toContain('Adam');
      expect(mockWriteCache).toHaveBeenCalledWith(voices);
    });
  });

  describe('status', () => {
    it('returns current state summary', async () => {
      mockLoadConfig.mockReturnValue(makeConfig());
      vi.mocked(session.isActive).mockReturnValue(false);

      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('status', [], 'sess-1');
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
      const result = await dispatch('test', [], 'sess-1');
      expect(result.speak).toBe(true);
      expect(result.message.length).toBeGreaterThan(0);
    });
  });

  describe('unknown command', () => {
    it('returns error with available commands', async () => {
      const { dispatch } = await import('../src/subcommands.js');
      const result = await dispatch('foobar', [], 'sess-1');
      expect(result.error).toBe(true);
      expect(result.message).toContain('foobar');
      expect(result.message).toContain('mute');
      expect(result.message).toContain('unmute');
    });
  });
});

describe('activation subcommands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('on activates the resolved session', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('on', [], 'sess-1');
    expect(session.activate).toHaveBeenCalledWith('sess-1');
    expect(result.error).toBeFalsy();
  });

  it('on reports an error and does not activate when the session id is unknown', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('on', [], null);
    expect(result.error).toBe(true);
    expect(session.activate).not.toHaveBeenCalled();
  });

  it('off deactivates the session', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('off', [], 'sess-1');
    expect(session.deactivate).toHaveBeenCalledWith('sess-1');
  });

  it('off succeeds without error when the session id is unknown', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('off', [], null);
    expect(result.error).toBeFalsy();
    expect(session.deactivate).not.toHaveBeenCalled();
  });

  it('mute is an alias for off', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('mute', [], 'sess-1');
    expect(session.deactivate).toHaveBeenCalledWith('sess-1');
  });

  it('unmute is an alias for on', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('unmute', [], 'sess-1');
    expect(session.activate).toHaveBeenCalledWith('sess-1');
  });

  it('on requests a spoken confirmation, so the user hears that it worked', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('on', [], 'sess-1');
    expect(result.speak).toBe(true);
  });

  it('off does not request speech', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('off', [], 'sess-1');
    expect(result.speak).toBe(false);
  });
});

describe('stop and turn-start subcommands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stop silences playback and never speaks', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('stop', [], 'sess-1');
    expect(player.stopPlayback).toHaveBeenCalled();
    expect(result.speak).toBe(false);
  });

  it('stop works even when the session id is unknown', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('stop', [], null);
    expect(player.stopPlayback).toHaveBeenCalled();
    expect(result.error).toBeFalsy();
  });

  it('turn-start silences playback and clears the turn flag', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('turn-start', [], 'sess-1');
    expect(player.stopPlayback).toHaveBeenCalled();
    expect(session.setSpokeThisTurn).toHaveBeenCalledWith('sess-1', false);
  });

  it('turn-start emits no output, so it cannot pollute the prompt', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('turn-start', [], 'sess-1');
    expect(result.message).toBe('');
    expect(result.speak).toBe(false);
  });

  it('turn-start scopes its stop to the submitting session', async () => {
    // One window's prompt must not discard another window's pending audio.
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('turn-start', [], 'sess-1');
    expect(player.stopPlayback).toHaveBeenCalledWith('sess-1');
  });

  it('stop is global, so !shutup silences whatever is audible', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('stop', [], 'sess-1');
    expect(player.stopPlayback).toHaveBeenCalledWith(null);
  });
});


describe('gc subcommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collects stale session state and emits nothing', async () => {
    // check-setup.sh calls this on every SessionStart.
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('gc', [], 'sess-1');

    expect(session.gcSessions).toHaveBeenCalled();
    expect(result.message).toBe('');
    expect(result.speak).toBe(false);
    expect(result.error).toBeFalsy();
  });
});

describe('status output', () => {
  beforeEach(async () => {
    const configMod = await import('../src/config.js');
    vi.mocked(configMod.loadConfig).mockReturnValue(makeConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the session as active when it is', async () => {
    vi.mocked(session.isActive).mockReturnValue(true);
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('status', [], 'sess-1');
    expect(result.message).toContain('Voice: active');
  });

  it('reports the session as off when inactive', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('status', [], 'sess-1');
    expect(result.message).toContain('Voice: off');
  });

  it('reports an unresolved session id explicitly', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('status', [], null);
    expect(result.message).toContain('Session: unknown');
  });

  it('reports playback as idle when nothing is playing', async () => {
    vi.mocked(player.readPlaybackState).mockReturnValue(null);
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('status', [], 'sess-1');
    expect(result.message).toContain('Playback: idle');
  });

  it('reports the in-flight playback and which session owns it', async () => {
    vi.mocked(player.readPlaybackState).mockReturnValue({
      pid: 4242,
      startedAt: 1785000000000,
      sessionId: 'sess-2',
    });
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('status', [], 'sess-1');
    expect(result.message).toContain('Playback: playing');
    expect(result.message).toContain('4242');
    expect(result.message).toContain('sess-2');
  });
});

describe('turn-start scope when the session id is unknown', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('kills audible playback without stamping a global stop', async () => {
    // stopPlayback(null) is the deliberate global mode used by !shutup.
    // Reusing it here would discard every other window's pending synthesis
    // on every prompt from an unresolved window.
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('turn-start', [], null);
    expect(player.killTrackedPlayback).toHaveBeenCalled();
    expect(player.stopPlayback).not.toHaveBeenCalled();
  });

  it('uses the session-scoped stop when the id is known', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('turn-start', [], 'sess-1');
    expect(player.stopPlayback).toHaveBeenCalledWith('sess-1');
  });
});

describe('off reports a failure it cannot hide', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('errors when the session file could not be removed', async () => {
    vi.mocked(session.deactivate).mockReturnValue(false);
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('off', [], 'sess-1');
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/could not/i);
  });

  it('confirms normally when removal succeeded', async () => {
    vi.mocked(session.deactivate).mockReturnValue(true);
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('off', [], 'sess-1');
    expect(result.error).toBeFalsy();
  });

  it('protects the live session from gc', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('gc', [], 'sess-1');
    expect(session.gcSessions).toHaveBeenCalledWith(undefined, 'sess-1');
  });
});
