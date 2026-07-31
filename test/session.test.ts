import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');

const HOME = '/mock/home';
const SESSIONS = '/mock/home/.claude-speak/sessions';
const ID = 'abc-123';
const FILE = `${SESSIONS}/abc-123.json`;
const LEGACY = '/mock/home/.claude-speak/session.json';

function stateFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ active: true, activatedAt: 1000, spokeThisTurn: false, ...overrides });
}

describe('session state', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(HOME);
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  describe('resolveSessionId', () => {
    it('prefers session_id from hook stdin over the environment', async () => {
      process.env.CLAUDE_CODE_SESSION_ID = 'from-env';
      const { resolveSessionId } = await import('../src/session.js');
      expect(resolveSessionId(JSON.stringify({ session_id: 'from-stdin' }))).toBe('from-stdin');
    });

    it('falls back to CLAUDE_CODE_SESSION_ID when stdin is absent', async () => {
      process.env.CLAUDE_CODE_SESSION_ID = 'from-env';
      const { resolveSessionId } = await import('../src/session.js');
      expect(resolveSessionId()).toBe('from-env');
    });

    it('falls back to the environment when stdin is not valid JSON', async () => {
      process.env.CLAUDE_CODE_SESSION_ID = 'from-env';
      const { resolveSessionId } = await import('../src/session.js');
      expect(resolveSessionId('not json{{{')).toBe('from-env');
    });

    it('returns null when neither source provides an id', async () => {
      const { resolveSessionId } = await import('../src/session.js');
      expect(resolveSessionId('{}')).toBeNull();
    });

    // A session id becomes a filename. Without validation, a crafted value
    // steers every subsequent read/write/unlink out of the sessions directory.
    it.each([
      ['a path separator', '../../../../etc/passwd'],
      ['a bare separator', 'a/b'],
      ['a leading separator', '/etc/hosts'],
      ['a backslash', 'abc\\def'],
      ['a space', 'abc def'],
      ['a tilde', '~'],
      ['an empty string', ''],
    ])('rejects a session id from stdin containing %s', async (_label, id) => {
      const { resolveSessionId } = await import('../src/session.js');
      expect(resolveSessionId(JSON.stringify({ session_id: id }))).toBeNull();
    });

    it('rejects an invalid session id from the environment', async () => {
      process.env.CLAUDE_CODE_SESSION_ID = '../../evil';
      const { resolveSessionId } = await import('../src/session.js');
      expect(resolveSessionId()).toBeNull();
    });

    it('treats an invalid stdin id as absent and falls back to the environment', async () => {
      // Same handling as a missing session_id or unparseable stdin: stdin simply
      // did not yield a usable id. The env value is validated in its own right,
      // so the fallback cannot smuggle a bad id through either.
      process.env.CLAUDE_CODE_SESSION_ID = 'from-env';
      const { resolveSessionId } = await import('../src/session.js');
      expect(resolveSessionId(JSON.stringify({ session_id: '../evil' }))).toBe('from-env');
    });

    it('returns null when both stdin and the environment carry invalid ids', async () => {
      process.env.CLAUDE_CODE_SESSION_ID = 'also/bad';
      const { resolveSessionId } = await import('../src/session.js');
      expect(resolveSessionId(JSON.stringify({ session_id: '../evil' }))).toBeNull();
    });

    it('accepts the real uuid shape Claude Code emits', async () => {
      const uuid = 'c77d0304-ecce-439a-b937-d990c063d18e';
      const { resolveSessionId } = await import('../src/session.js');
      expect(resolveSessionId(JSON.stringify({ session_id: uuid }))).toBe(uuid);
    });
  });

  describe('isActive', () => {
    it('returns false when no session file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { isActive } = await import('../src/session.js');
      expect(isActive(ID)).toBe(false);
    });

    it('returns true when the session file marks it active', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(stateFile());
      const { isActive } = await import('../src/session.js');
      expect(isActive(ID)).toBe(true);
    });

    it('returns false for a null session id without touching the filesystem', async () => {
      const { isActive } = await import('../src/session.js');
      expect(isActive(null)).toBe(false);
      expect(fs.existsSync).not.toHaveBeenCalled();
    });

    it('deletes a corrupt session file and reports inactive', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not json{{{');
      const { isActive } = await import('../src/session.js');
      expect(isActive(ID)).toBe(false);
      expect(fs.unlinkSync).toHaveBeenCalledWith(FILE);
    });

    it('isolates sessions from each other', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => p === FILE);
      vi.mocked(fs.readFileSync).mockReturnValue(stateFile());
      const { isActive } = await import('../src/session.js');
      expect(isActive(ID)).toBe(true);
      expect(isActive('other-session')).toBe(false);
    });
  });

  describe('activate / deactivate', () => {
    it('creates the sessions directory and writes an active state', async () => {
      const { activate } = await import('../src/session.js');
      activate(ID);
      expect(fs.mkdirSync).toHaveBeenCalledWith(SESSIONS, { recursive: true });
      const [writtenPath, contents] = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(writtenPath).toBe(FILE);
      const parsed = JSON.parse(contents as string);
      expect(parsed.active).toBe(true);
      expect(parsed.spokeThisTurn).toBe(false);
      expect(typeof parsed.activatedAt).toBe('number');
    });

    it('deletes the session file on deactivate', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const { deactivate } = await import('../src/session.js');
      deactivate(ID);
      expect(fs.unlinkSync).toHaveBeenCalledWith(FILE);
    });

    it('deactivate is a no-op when no file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { deactivate } = await import('../src/session.js');
      deactivate(ID);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('does not throw when the state directory cannot be created', async () => {
      // Activation state is best-effort everywhere else; an EACCES here would
      // otherwise escape run() and crash the hook.
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });
      const { activate } = await import('../src/session.js');
      expect(() => activate(ID)).not.toThrow();
    });

    it('does not throw when the state file cannot be written', async () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        const err = new Error('no space left on device') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      });
      const { activate } = await import('../src/session.js');
      expect(() => activate(ID)).not.toThrow();
    });
  });

  describe('spokeThisTurn', () => {
    it('is a no-op when the session file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { setSpokeThisTurn } = await import('../src/session.js');
      setSpokeThisTurn(ID, true);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('sets the flag while preserving activatedAt', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(stateFile({ activatedAt: 4242 }));
      const { setSpokeThisTurn } = await import('../src/session.js');
      setSpokeThisTurn(ID, true);
      const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(parsed.spokeThisTurn).toBe(true);
      expect(parsed.activatedAt).toBe(4242);
    });

    it('consume returns true and resets the flag', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(stateFile({ spokeThisTurn: true }));
      const { consumeSpokeThisTurn } = await import('../src/session.js');
      expect(consumeSpokeThisTurn(ID)).toBe(true);
      const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(parsed.spokeThisTurn).toBe(false);
    });

    it('consume returns false when the flag was already clear', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(stateFile({ spokeThisTurn: false }));
      const { consumeSpokeThisTurn } = await import('../src/session.js');
      expect(consumeSpokeThisTurn(ID)).toBe(false);
    });

    it('consume returns false when no session file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { consumeSpokeThisTurn } = await import('../src/session.js');
      expect(consumeSpokeThisTurn(ID)).toBe(false);
    });
  });

  describe('gcSessions', () => {
    it('removes stale session files and keeps fresh ones', async () => {
      const now = Date.now();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(['stale.json', 'fresh.json'] as never);
      vi.mocked(fs.statSync).mockImplementation((p) => ({
        mtimeMs: String(p).includes('stale') ? now - 48 * 3600 * 1000 : now,
      }) as fs.Stats);

      const { gcSessions } = await import('../src/session.js');
      gcSessions();

      expect(fs.unlinkSync).toHaveBeenCalledWith(`${SESSIONS}/stale.json`);
      expect(fs.unlinkSync).not.toHaveBeenCalledWith(`${SESSIONS}/fresh.json`);
    });

    it('removes the legacy 1.x session.json without migrating it', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([] as never);
      const { gcSessions } = await import('../src/session.js');
      gcSessions();
      expect(fs.unlinkSync).toHaveBeenCalledWith(LEGACY);
    });

    it('does nothing when the sessions directory is absent', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { gcSessions } = await import('../src/session.js');
      expect(() => gcSessions()).not.toThrow();
      expect(fs.readdirSync).not.toHaveBeenCalled();
    });
  });
});

// !shutup killed the narration and the Stop hook then spoke Claude's reply
// ("Quiet."), so asking for silence produced a new spoken word. Observed twice
// in a real session before this flag existed.
describe('silencedThisTurn', () => {
  const HOME2 = '/mock/home';
  const FILE2 = `${HOME2}/.claude-speak/sessions/abc-123.json`;

  // This block sits at file scope, so it does not inherit the top-level
  // afterEach — without its own reset, mock call history leaks between tests
  // and `mock.calls[0]` picks up an earlier test's write.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(HOME2);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('is a no-op when the session has no state file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { setSilencedThisTurn } = await import('../src/session.js');
    setSilencedThisTurn(ID);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('records the flag without disturbing activation', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(stateFile({ activatedAt: 4242 }));
    const { setSilencedThisTurn } = await import('../src/session.js');
    setSilencedThisTurn(ID);
    const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(parsed.silencedThisTurn).toBe(true);
    expect(parsed.active).toBe(true);
    expect(parsed.activatedAt).toBe(4242);
  });

  it('consume returns true once and clears the flag', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(stateFile({ silencedThisTurn: true }));
    const { consumeSilencedThisTurn } = await import('../src/session.js');
    expect(consumeSilencedThisTurn(ID)).toBe(true);
    const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(parsed.silencedThisTurn).toBe(false);
  });

  it('consume returns false when the flag was never set', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(stateFile());
    const { consumeSilencedThisTurn } = await import('../src/session.js');
    expect(consumeSilencedThisTurn(ID)).toBe(false);
  });

  it('is independent of spokeThisTurn', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      stateFile({ silencedThisTurn: true, spokeThisTurn: true }),
    );
    const { consumeSilencedThisTurn } = await import('../src/session.js');
    consumeSilencedThisTurn(ID);
    const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
    expect(parsed.silencedThisTurn).toBe(false);
    expect(parsed.spokeThisTurn).toBe(true);
  });

  it('defaults to false on a state file written before the field existed', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ active: true, activatedAt: 1, spokeThisTurn: false }),
    );
    const { loadSessionState } = await import('../src/session.js');
    expect(loadSessionState(ID)?.silencedThisTurn).toBe(false);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(FILE2);
  });
});

// check-setup.sh runs gc before it reports activation state. Collecting the
// live session there silently deactivates a session that is resuming, which
// contradicts the guarantee that activation survives resume.
describe('gcSessions protects the live session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(HOME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('keeps the protected session even when its mtime is stale', async () => {
    const stale = Date.now() - 48 * 3600 * 1000;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['abc-123.json', 'other.json'] as never);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: stale } as fs.Stats);

    const { gcSessions } = await import('../src/session.js');
    gcSessions(undefined, 'abc-123');

    expect(fs.unlinkSync).not.toHaveBeenCalledWith(`${SESSIONS}/abc-123.json`);
    expect(fs.unlinkSync).toHaveBeenCalledWith(`${SESSIONS}/other.json`);
  });

  it('still collects everything when no session is protected', async () => {
    const stale = Date.now() - 48 * 3600 * 1000;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['abc-123.json'] as never);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: stale } as fs.Stats);

    const { gcSessions } = await import('../src/session.js');
    gcSessions(undefined, null);

    expect(fs.unlinkSync).toHaveBeenCalledWith(`${SESSIONS}/abc-123.json`);
  });
});

// deactivate swallowed unlink errors while /speak off reported success, so
// narration continued after the user was told voice was off (finding 6).
describe('deactivate reports whether the state actually went away', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(HOME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns true when the file is removed', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { deactivate } = await import('../src/session.js');
    expect(deactivate(ID)).toBe(true);
  });

  it('returns true when there was nothing to remove', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { deactivate } = await import('../src/session.js');
    expect(deactivate(ID)).toBe(true);
  });

  it('returns false when the file cannot be removed', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      const err = new Error('read-only file system') as NodeJS.ErrnoException;
      err.code = 'EROFS';
      throw err;
    });
    const { deactivate } = await import('../src/session.js');
    expect(deactivate(ID)).toBe(false);
  });
});
