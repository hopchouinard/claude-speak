import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, type VoiceConfig } from '../src/config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-4o-mini-tts-2025-12-15');
    expect(config.voice).toBe('ash');
    expect(config.enabled).toBe(false);
  });

  it('loads and merges config file with defaults', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      voice: 'nova',
      instructions: 'Be sassy',
    }));
    const config = loadConfig();
    expect(config.voice).toBe('nova');
    expect(config.instructions).toBe('Be sassy');
    expect(config.provider).toBe('openai');
    expect(config.enabled).toBe(true);
  });

  it('respects CLAUDE_VOICE_ENABLED=false env override', () => {
    vi.stubEnv('CLAUDE_VOICE_ENABLED', 'false');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
    const config = loadConfig();
    expect(config.enabled).toBe(false);
  });

  it('reads API key from CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY', () => {
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY', 'sk-test-key');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
    const config = loadConfig();
    expect(config.apiKey).toBe('sk-test-key');
  });

  it('returns null apiKey when env var is not set', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
    const config = loadConfig();
    expect(config.apiKey).toBeNull();
  });

  it('handles malformed config file gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');
    const config = loadConfig();
    expect(config.enabled).toBe(false);
    expect(config.error).toBe('malformed-config');
  });
});
