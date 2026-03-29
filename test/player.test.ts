import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playAudio } from '../src/player.js';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process');
vi.mock('node:fs');

describe('playAudio', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/claude-voice-abc');
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(child_process.spawn).mockReturnValue({
      unref: vi.fn(),
      on: vi.fn(),
    } as unknown as child_process.ChildProcess);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes audio buffer to a temp file', () => {
    const audio = Buffer.from('audio-data');
    playAudio(audio, 'afplay');

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('claude-voice'),
      audio
    );
  });

  it('spawns the playback command with the temp file', () => {
    const audio = Buffer.from('audio-data');
    playAudio(audio, 'afplay');

    expect(child_process.spawn).toHaveBeenCalledWith(
      'afplay',
      [expect.stringContaining('claude-voice')],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
  });

  it('unrefs the child process so Node can exit', () => {
    const mockUnref = vi.fn();
    vi.mocked(child_process.spawn).mockReturnValue({
      unref: mockUnref,
      on: vi.fn(),
    } as unknown as child_process.ChildProcess);

    playAudio(Buffer.from('audio'), 'afplay');
    expect(mockUnref).toHaveBeenCalled();
  });
});
