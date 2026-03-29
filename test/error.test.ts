import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleError } from '../src/error.js';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';

vi.mock('node:child_process');
vi.mock('node:fs');

describe('handleError', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.appendFileSync).mockReturnValue(undefined);
    vi.mocked(child_process.spawnSync).mockReturnValue({
      status: 0,
    } as child_process.SpawnSyncReturns<string>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs error to file with timestamp', () => {
    const now = new Date('2026-03-28T12:00:00Z');
    vi.spyOn(global, 'Date').mockImplementation(() => now);

    handleError(new Error('API timeout'), '/tmp/voice.log');

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/voice.log',
      expect.stringContaining('API timeout')
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/voice.log',
      expect.stringContaining('2026')
    );
  });

  it('creates log directory if needed', () => {
    handleError(new Error('test'), '/tmp/logs/voice.log');

    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/logs', { recursive: true });
  });

  it('plays system beep on macOS', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    handleError(new Error('test'), '/tmp/voice.log');

    expect(child_process.spawnSync).toHaveBeenCalledWith(
      'afplay',
      ['/System/Library/Sounds/Basso.aiff']
    );

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('does not throw even if logging fails', () => {
    vi.mocked(fs.appendFileSync).mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => handleError(new Error('test'), '/tmp/voice.log')).not.toThrow();
  });
});
