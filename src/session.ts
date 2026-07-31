import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SessionState {
  active: boolean;
  activatedAt: number;
  spokeThisTurn: boolean;
  /**
   * Set when the user explicitly asked for silence during this turn (`!shutup`
   * or `--cmd stop`). The end-of-turn message is then not spoken: having the
   * interrupt kill one narration and immediately start another is the opposite
   * of what was asked for. Cleared at the next turn, so speech resumes on its
   * own without needing `/speak on` again.
   */
  silencedThisTurn: boolean;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function getSessionsDir(): string {
  return path.join(os.homedir(), '.claude-speak', 'sessions');
}

export function getSessionPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

/**
 * A session id becomes a filename, so it must not be able to steer the path.
 * Anything containing a separator would escape the sessions directory on the
 * read/write/unlink that follows.
 *
 * This is the same character class scripts/check-setup.sh applies to the id it
 * reads from the SessionStart payload — the shell and this module must agree on
 * what counts as a usable id, or they will disagree about whether a session is
 * active. Keep the two in step.
 */
const VALID_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function asValidSessionId(value: unknown): string | null {
  return typeof value === 'string' && VALID_SESSION_ID.test(value) ? value : null;
}

/**
 * Resolve the current Claude Code session id.
 *
 * Hook stdin is authoritative because it is supplied by the harness for the
 * exact session firing the hook. The env var covers the Bash-tool path, where
 * there is no hook payload. When neither is available we return null rather
 * than falling back to a shared key — a shared key would reintroduce the
 * cross-session leakage this design removes.
 *
 * An id that fails validation is treated as unresolvable rather than sanitized:
 * silently rewriting it would point the caller at a different session's file.
 */
export function resolveSessionId(stdin?: string): string | null {
  if (stdin) {
    try {
      const parsed = JSON.parse(stdin) as Record<string, unknown>;
      const fromStdin = asValidSessionId(parsed.session_id);
      if (fromStdin) return fromStdin;
    } catch {
      // Fall through to the environment.
    }
  }

  return asValidSessionId(process.env.CLAUDE_CODE_SESSION_ID);
}

export function loadSessionState(sessionId: string): SessionState | null {
  const filePath = getSessionPath(sessionId);
  if (!fs.existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    if (typeof parsed.active !== 'boolean') throw new Error('invalid state');
    return {
      active: parsed.active,
      activatedAt: typeof parsed.activatedAt === 'number' ? parsed.activatedAt : 0,
      spokeThisTurn: parsed.spokeThisTurn === true,
      silencedThisTurn: parsed.silencedThisTurn === true,
    };
  } catch {
    // Corrupt state is indistinguishable from no state: remove it and stay silent.
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best effort.
    }
    return null;
  }
}

/**
 * Best effort, like every other write in this module. An EACCES or ENOSPC
 * here would otherwise escape run() and crash the hook that called it — a
 * failure to record activation state is not worth taking the harness down
 * for, and every read path already treats a missing file as "voice off".
 */
function writeSessionState(sessionId: string, state: SessionState): void {
  const filePath = getSessionPath(sessionId);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Best effort.
  }
}

export function isActive(sessionId: string | null): boolean {
  if (!sessionId) return false;
  return loadSessionState(sessionId)?.active === true;
}

export function activate(sessionId: string): void {
  writeSessionState(sessionId, {
    active: true,
    activatedAt: Date.now(),
    spokeThisTurn: false,
    silencedThisTurn: false,
  });
}

export function deactivate(sessionId: string): void {
  const filePath = getSessionPath(sessionId);
  if (!fs.existsSync(filePath)) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best effort.
  }
}

/**
 * No-op when the session has no state file. An inactive session never speaks,
 * so there is nothing for the Stop hook to suppress.
 */
export function setSpokeThisTurn(sessionId: string, value: boolean): void {
  const state = loadSessionState(sessionId);
  if (!state) return;
  writeSessionState(sessionId, { ...state, spokeThisTurn: value });
}

/**
 * Read the flag and always clear it, returning the prior value.
 *
 * Clearing unconditionally is deliberate: if the UserPromptSubmit hook ever
 * fails to fire, the worst outcome is one suppressed message rather than
 * permanent silence.
 */
export function consumeSpokeThisTurn(sessionId: string): boolean {
  const state = loadSessionState(sessionId);
  if (!state) return false;
  if (state.spokeThisTurn) {
    writeSessionState(sessionId, { ...state, spokeThisTurn: false });
  }
  return state.spokeThisTurn;
}

/**
 * Record that the user asked for silence during this turn.
 *
 * No-op without a session file: an inactive session has no end-of-turn speech
 * to suppress. Also a no-op when the id cannot be resolved, which is why
 * `shutup` run from a plain terminal still kills audio but cannot suppress a
 * later message — it has no way to know which session to mark.
 */
export function setSilencedThisTurn(sessionId: string): void {
  const state = loadSessionState(sessionId);
  if (!state) return;
  writeSessionState(sessionId, { ...state, silencedThisTurn: true });
}

/**
 * Read the silence flag and always clear it, returning the prior value.
 *
 * Clearing unconditionally matches consumeSpokeThisTurn: if the turn-start hook
 * ever fails to fire, one suppressed message is a far better failure than a
 * session that has gone permanently mute.
 */
export function consumeSilencedThisTurn(sessionId: string): boolean {
  const state = loadSessionState(sessionId);
  if (!state) return false;
  if (state.silencedThisTurn) {
    writeSessionState(sessionId, { ...state, silencedThisTurn: false });
  }
  return state.silencedThisTurn;
}

/**
 * Remove session files untouched for maxAgeMs, plus the legacy 1.x global
 * session.json. The legacy file is deleted rather than migrated: its semantics
 * (global, default-audible) are the inverse of the new model.
 *
 * Staleness uses mtime rather than activatedAt so that a long-running session
 * writing its turn flag each turn is never collected.
 */
export function gcSessions(maxAgeMs: number = DEFAULT_MAX_AGE_MS): void {
  const legacyPath = path.join(os.homedir(), '.claude-speak', 'session.json');
  if (fs.existsSync(legacyPath)) {
    try {
      fs.unlinkSync(legacyPath);
    } catch {
      // Best effort.
    }
  }

  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return;

  const cutoff = Date.now() - maxAgeMs;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir) as unknown as string[];
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(dir, entry);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best effort per file.
    }
  }
}
