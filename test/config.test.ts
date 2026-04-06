import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    vi.resetModules();
  });

  it('returns defaults when no config file exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.activeProvider).toBe('openai');
    expect(config.providers.openai.model).toBe('gpt-4o-mini-tts-2025-12-15');
    expect(config.providers.openai.voice).toBe('ash');
    expect(config.enabled).toBe(false);
  });

  it('loads new nested config format', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      activeProvider: 'elevenlabs',
      providers: {
        elevenlabs: {
          model: 'eleven_multilingual_v2',
          voice: 'Rachel',
          speed: 1.0,
          stability: 0.7,
          similarityBoost: 0.8,
          style: 0.1,
        },
      },
    }));
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.activeProvider).toBe('elevenlabs');
    expect(config.providers.elevenlabs.voice).toBe('Rachel');
    expect(config.providers.elevenlabs.stability).toBe(0.7);
    expect(config.providers.elevenlabs.similarityBoost).toBe(0.8);
    expect(config.providers.elevenlabs.style).toBe(0.1);
    expect(config.enabled).toBe(true);
  });

  it('auto-migrates old flat format', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'nova',
      speed: 1.2,
    }));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.activeProvider).toBe('openai');
    expect(config.providers.openai.voice).toBe('nova');
    expect(config.providers.openai.speed).toBe(1.2);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('continues in memory if migration write fails', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'echo',
      speed: 1.0,
    }));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.activeProvider).toBe('openai');
    expect(config.providers.openai.voice).toBe('echo');
    expect(config.error).toBeUndefined();
  });

  it('respects CLAUDE_SPEAK_ENABLED=false env override', async () => {
    vi.stubEnv('CLAUDE_SPEAK_ENABLED', 'false');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      activeProvider: 'openai',
      providers: { openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'ash', speed: 1.0 } },
    }));
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.enabled).toBe(false);
  });

  it('reads OpenAI API key from CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY env', async () => {
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY', 'sk-test-key');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.apiKeys.openai).toBe('sk-test-key');
  });

  it('reads ElevenLabs API key from ELEVENLABS_API_KEY env', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'el-test-key');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.apiKeys.elevenlabs).toBe('el-test-key');
  });

  it('handles malformed config file gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.enabled).toBe(false);
    expect(config.error).toBe('malformed-config');
  });
});
