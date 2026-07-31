import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playAudio } from '../src/player.js';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process');
vi.mock('node:fs');
vi.mock('node:os');

describe('playAudio', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/mock/home');
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/claude-speak-abc');
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
      expect.stringContaining('claude-speak'),
      audio
    );
  });

  it('spawns the playback command with the temp file', () => {
    const audio = Buffer.from('audio-data');
    playAudio(audio, 'afplay');

    expect(child_process.spawn).toHaveBeenCalledWith(
      'afplay',
      [expect.stringContaining('claude-speak')],
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

describe('playAudio pid tracking', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/mock/home');
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/claude-speak-abc');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the child pid to playback.json', () => {
    vi.mocked(child_process.spawn).mockReturnValue({
      pid: 4242,
      unref: vi.fn(),
      on: vi.fn(),
    } as unknown as child_process.ChildProcess);

    playAudio(Buffer.from('audio'), 'afplay');

    const call = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([p]) => String(p).endsWith('playback.json'));
    expect(call).toBeDefined();
    expect(JSON.parse(call![1] as string).pid).toBe(4242);
  });

  it('clears playback.json when the child exits', () => {
    let exitHandler: (() => void) | undefined;
    vi.mocked(child_process.spawn).mockReturnValue({
      pid: 4242,
      unref: vi.fn(),
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'exit') exitHandler = cb;
      }),
    } as unknown as child_process.ChildProcess);
    vi.mocked(fs.existsSync).mockReturnValue(true);

    playAudio(Buffer.from('audio'), 'afplay');
    exitHandler!();

    expect(fs.unlinkSync).toHaveBeenCalledWith('/mock/home/.claude-speak/playback.json');
  });
});

describe('playAudio single-stream invariant', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/mock/home');
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/claude-speak-abc');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops a stream that is already playing before starting a new one', () => {
    // Otherwise the earlier pid is overwritten in playback.json and becomes
    // unaddressable: `!shutup` could only ever silence the newest stream.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ pid: 111, sessionId: 'sess-a' }));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(child_process.spawn).mockReturnValue({
      pid: 222,
      unref: vi.fn(),
      on: vi.fn(),
    } as unknown as child_process.ChildProcess);

    playAudio(Buffer.from('audio'), 'afplay', 'sess-b');

    expect(kill).toHaveBeenCalledWith(111, 'SIGTERM');
    const call = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([p]) => String(p).endsWith('playback.json'));
    expect(JSON.parse(call![1] as string).pid).toBe(222);
  });

  it('does not stamp a stop epoch when it clears the previous stream', () => {
    // Stamping here would discard another session's not-yet-playing audio.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ pid: 111 }));
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(child_process.spawn).mockReturnValue({
      pid: 222,
      unref: vi.fn(),
      on: vi.fn(),
    } as unknown as child_process.ChildProcess);

    playAudio(Buffer.from('audio'), 'afplay', 'sess-b');

    const epochWrite = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([p]) => String(p).endsWith('stop-epoch'));
    expect(epochWrite).toBeUndefined();
  });

  it('records the session that owns the playback', () => {
    vi.mocked(child_process.spawn).mockReturnValue({
      pid: 4242,
      unref: vi.fn(),
      on: vi.fn(),
    } as unknown as child_process.ChildProcess);

    playAudio(Buffer.from('audio'), 'afplay', 'sess-1');

    const call = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([p]) => String(p).endsWith('playback.json'));
    expect(JSON.parse(call![1] as string).sessionId).toBe('sess-1');
  });
});

describe('stopPlayback', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/mock/home');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stamps the stop epoch before killing, so a racing synthesis still sees it', async () => {
    const order: string[] = [];
    vi.mocked(fs.writeFileSync).mockImplementation((p) => {
      if (String(p).endsWith('stop-epoch')) order.push('epoch');
      return undefined;
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ pid: 4242 }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      order.push('kill');
      return true;
    });

    const { stopPlayback } = await import('../src/player.js');
    stopPlayback();

    expect(order).toEqual(['epoch', 'kill']);
  });

  it('sends SIGTERM to the recorded pid and removes the pid file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ pid: 4242 }));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    const { stopPlayback } = await import('../src/player.js');
    stopPlayback();

    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(fs.unlinkSync).toHaveBeenCalledWith('/mock/home/.claude-speak/playback.json');
  });

  it('does not throw when the recorded process is already gone', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ pid: 4242 }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    const { stopPlayback } = await import('../src/player.js');
    expect(() => stopPlayback()).not.toThrow();
  });

  it('still stamps the epoch when there is no pid file', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => !String(p).endsWith('playback.json'));

    const { stopPlayback } = await import('../src/player.js');
    stopPlayback();

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/mock/home/.claude-speak/stop-epoch',
      expect.any(String),
      'utf-8',
    );
  });
});

describe('readStopEpoch', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/mock/home');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 when the file is absent', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { readStopEpoch } = await import('../src/player.js');
    expect(readStopEpoch()).toBe(0);
  });

  it('returns the stored timestamp', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('1785000000000');
    const { readStopEpoch } = await import('../src/player.js');
    expect(readStopEpoch()).toBe(1785000000000);
  });

  it('returns 0 for unparseable contents', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('garbage');
    const { readStopEpoch } = await import('../src/player.js');
    expect(readStopEpoch()).toBe(0);
  });
});

describe('stop-epoch session scoping', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/mock/home');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the session that stamped a scoped stop', async () => {
    const { stopPlayback } = await import('../src/player.js');
    vi.mocked(fs.existsSync).mockReturnValue(false);

    stopPlayback('sess-1');

    const call = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([p]) => String(p).endsWith('stop-epoch'));
    expect(JSON.parse(call![1] as string).sessionId).toBe('sess-1');
  });

  it('records no session for a global stop', async () => {
    const { stopPlayback } = await import('../src/player.js');
    vi.mocked(fs.existsSync).mockReturnValue(false);

    stopPlayback(null);

    const call = vi
      .mocked(fs.writeFileSync)
      .mock.calls.find(([p]) => String(p).endsWith('stop-epoch'));
    expect(JSON.parse(call![1] as string).sessionId).toBeNull();
  });

  it('hides another session’s stop from this session', async () => {
    // Window B submitting a prompt must not discard window A's pending audio.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ epoch: 1785000000000, sessionId: 'sess-b' }),
    );
    const { readStopEpoch } = await import('../src/player.js');
    expect(readStopEpoch('sess-a')).toBe(0);
  });

  it('honours a stop stamped by the same session', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ epoch: 1785000000000, sessionId: 'sess-a' }),
    );
    const { readStopEpoch } = await import('../src/player.js');
    expect(readStopEpoch('sess-a')).toBe(1785000000000);
  });

  it('honours an unattributed global stop for every session', async () => {
    // `!shutup` is a panic button: silence the machine, whoever asked.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ epoch: 1785000000000, sessionId: null }),
    );
    const { readStopEpoch } = await import('../src/player.js');
    expect(readStopEpoch('sess-a')).toBe(1785000000000);
  });

  it('treats a legacy bare-number epoch as global', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('1785000000000');
    const { readStopEpoch } = await import('../src/player.js');
    expect(readStopEpoch('sess-a')).toBe(1785000000000);
  });
});

describe('readPlaybackState', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/mock/home');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when nothing is playing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { readPlaybackState } = await import('../src/player.js');
    expect(readPlaybackState()).toBeNull();
  });

  it('returns the recorded pid and owning session', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ pid: 4242, startedAt: 1785000000000, sessionId: 'sess-1' }),
    );
    const { readPlaybackState } = await import('../src/player.js');
    expect(readPlaybackState()).toEqual({
      pid: 4242,
      startedAt: 1785000000000,
      sessionId: 'sess-1',
    });
  });

  it('returns null for a corrupt playback file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not json');
    const { readPlaybackState } = await import('../src/player.js');
    expect(readPlaybackState()).toBeNull();
  });
});
