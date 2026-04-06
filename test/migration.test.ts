import { describe, it, expect } from 'vitest';
import { isOldFormat, migrateConfig } from '../src/migration.js';

describe('isOldFormat', () => {
  it('detects old flat format (has provider key, no providers block)', () => {
    const config = {
      provider: 'openai',
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'ash',
      speed: 1.0,
    };
    expect(isOldFormat(config)).toBe(true);
  });

  it('returns false for new nested format (has activeProvider and providers)', () => {
    const config = {
      activeProvider: 'openai',
      providers: {
        openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'ash', speed: 1.0 },
      },
    };
    expect(isOldFormat(config)).toBe(false);
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
      voice: 'nova',
      instructions: 'Be sassy',
      speed: 1.2,
    };
    const result = migrateConfig(old);
    expect(result.activeProvider).toBe('openai');
    expect(result.providers.openai).toEqual({
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'nova',
      instructions: 'Be sassy',
      speed: 1.2,
    });
  });

  it('uses defaults for missing provider fields', () => {
    const old = {
      provider: 'openai',
    };
    const result = migrateConfig(old);
    expect(result.providers.openai.model).toBe('gpt-4o-mini-tts-2025-12-15');
    expect(result.providers.openai.voice).toBe('ash');
    expect(result.providers.openai.speed).toBe(1.0);
  });

  it('preserves shared settings (hooks, cooldown, timeout, logFile, playback)', () => {
    const old = {
      provider: 'openai',
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'ash',
      speed: 1.0,
      hooks: { stop: false, notification: true },
      cooldown: 30,
      timeout: 60,
      logFile: '/custom/path/voice.log',
      playback: { command: 'mpv' },
    };
    const result = migrateConfig(old);
    expect(result.hooks).toEqual({ stop: false, notification: true });
    expect(result.cooldown).toBe(30);
    expect(result.timeout).toBe(60);
    expect(result.logFile).toBe('/custom/path/voice.log');
    expect(result.playback).toEqual({ command: 'mpv' });
  });
});
