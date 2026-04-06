import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');

describe('voice-cache', () => {
  const mockHome = '/mock/home';

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe('readCache', () => {
    it('returns null when cache file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { readCache } = await import('../src/voice-cache.js');
      const result = readCache();
      expect(result).toBeNull();
    });

    it('returns parsed cache data', async () => {
      const cacheData = {
        fetched: '2026-04-05T00:00:00.000Z',
        voices: [
          { name: 'Rachel', voiceId: 'abc123', category: 'premade' },
        ],
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cacheData));
      const { readCache } = await import('../src/voice-cache.js');
      const result = readCache();
      expect(result).toEqual(cacheData);
    });

    it('returns null for corrupted cache', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');
      const { readCache } = await import('../src/voice-cache.js');
      const result = readCache();
      expect(result).toBeNull();
    });
  });

  describe('resolveVoiceName', () => {
    it('does case-insensitive match and returns voiceId', async () => {
      const voices = [
        { name: 'Rachel', voiceId: 'abc123', category: 'premade' },
        { name: 'Adam', voiceId: 'def456', category: 'premade' },
      ];
      const { resolveVoiceName } = await import('../src/voice-cache.js');
      expect(resolveVoiceName('rachel', voices)).toBe('abc123');
      expect(resolveVoiceName('RACHEL', voices)).toBe('abc123');
      expect(resolveVoiceName('Rachel', voices)).toBe('abc123');
    });

    it('matches by prefix when exact match fails', async () => {
      const voices = [
        { name: 'Nina - nerdy', voiceId: 'nina123', category: 'generated' },
        { name: 'Rachel', voiceId: 'abc123', category: 'premade' },
      ];
      const { resolveVoiceName } = await import('../src/voice-cache.js');
      expect(resolveVoiceName('Nina', voices)).toBe('nina123');
    });

    it('matches by substring when prefix fails', async () => {
      const voices = [
        { name: 'Nina - nerdy', voiceId: 'nina123', category: 'generated' },
      ];
      const { resolveVoiceName } = await import('../src/voice-cache.js');
      expect(resolveVoiceName('nerdy', voices)).toBe('nina123');
    });

    it('prefers exact match over prefix', async () => {
      const voices = [
        { name: 'Nina - nerdy', voiceId: 'nina-nerdy', category: 'generated' },
        { name: 'Nina', voiceId: 'nina-exact', category: 'premade' },
      ];
      const { resolveVoiceName } = await import('../src/voice-cache.js');
      expect(resolveVoiceName('Nina', voices)).toBe('nina-exact');
    });

    it('returns null for unknown name', async () => {
      const voices = [
        { name: 'Rachel', voiceId: 'abc123', category: 'premade' },
      ];
      const { resolveVoiceName } = await import('../src/voice-cache.js');
      expect(resolveVoiceName('UnknownVoice', voices)).toBeNull();
    });
  });

  describe('writeCache', () => {
    it('writes cache to file with fetched timestamp', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as unknown as string);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});
      const { writeCache } = await import('../src/voice-cache.js');
      const voices = [
        { name: 'Rachel', voiceId: 'abc123', category: 'premade' },
      ];
      writeCache(voices);
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const writtenPath = vi.mocked(fs.writeFileSync).mock.calls[0][0];
      const writtenData = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenPath).toBe('/mock/home/.claude-speak/voices-elevenlabs.json');
      expect(writtenData.voices).toEqual(voices);
      expect(writtenData.fetched).toBeDefined();
      expect(() => new Date(writtenData.fetched)).not.toThrow();
    });
  });
});
