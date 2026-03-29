import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeLock, isLocked } from '../src/lock.js';
import * as fs from 'node:fs';

vi.mock('node:fs');

describe('lock manager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('writeLock', () => {
    it('writes current timestamp to lockfile', () => {
      const now = 1711648000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      writeLock('/tmp/voice.lock');

      expect(fs.writeFileSync).toHaveBeenCalledWith('/tmp/voice.lock', String(now));
    });

    it('creates parent directory if needed', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      writeLock('/tmp/subdir/voice.lock');

      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/subdir', { recursive: true });
    });
  });

  describe('isLocked', () => {
    it('returns false when lockfile does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(isLocked('/tmp/voice.lock', 15)).toBe(false);
    });

    it('returns true when lock is within cooldown window', () => {
      const now = 1711648000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(String(now - 5000));

      expect(isLocked('/tmp/voice.lock', 15)).toBe(true);
    });

    it('returns false when lock is outside cooldown window', () => {
      const now = 1711648000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(String(now - 20000));

      expect(isLocked('/tmp/voice.lock', 15)).toBe(false);
    });

    it('returns false when lockfile content is invalid', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not-a-number');

      expect(isLocked('/tmp/voice.lock', 15)).toBe(false);
    });
  });
});
