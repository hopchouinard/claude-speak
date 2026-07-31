# Opt-In Voice, Condensation & Interrupt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make claude-speak voice output opt-in per session, condense unlistenable output before TTS, and let the user interrupt in-flight narration.

**Architecture:** Session activation becomes the existence of `~/.claude-speak/sessions/<session_id>.json`, replacing a global `muted` boolean. A condensation stage sits between message extraction and the existing sanitizer, falling back from an LLM rewrite to deterministic heuristics. Playback gains a PID file plus a stop-epoch timestamp so audio can be killed even mid-synthesis. A new `UserPromptSubmit` hook provides a real turn boundary, which replaces the time-based Stop-hook dedup lock with an exact per-turn flag.

**Tech Stack:** TypeScript (ESM, `NodeNext`), Node 22, vitest, esbuild bundle to `dist/cli.js`, raw `fetch` for the OpenAI chat completions API.

**Spec:** `docs/superpowers/specs/2026-07-29-opt-in-voice-condensation-interrupt-design.md`

## Global Constraints

- **No new runtime dependencies.** The summarizer uses global `fetch`. Do not add an SDK.
- **All relative imports end in `.js`** even though sources are `.ts` (ESM + `NodeNext`). Existing code does this; match it.
- **Test style:** vitest with `vi.mock('node:fs')` / `vi.mock('node:os')`, `vi.spyOn(os, 'homedir')`, dynamic `await import('../src/x.js')` inside each test, and `vi.restoreAllMocks()` + `vi.resetModules()` in `afterEach`. Match `test/session.test.ts`.
- **Exact values, copied verbatim from the spec:**
  - Summarizer model default: `gpt-5.4-nano-2026-03-17`
  - `speech.maxChars` default: `500`
  - `speech.summarizer.timeout` default: `8` (seconds)
  - `speech.summarizer.maxWords` default: `40`
  - List-item condensation trigger: **5 or more** items
  - Session GC age: **24 hours**
  - Executable name: exactly `shutup`
  - Version: `2.0.0` in both `package.json` and `.claude-plugin/plugin.json`
- **Every hook command must exit 0 always.** A non-zero exit from `UserPromptSubmit` blocks the user's prompt.
- **Never beep on a routine fallback.** `handleError()` plays an audible error sound; use `logWarning()` for summarizer failures.
- **`--cmd` routing must stay reachable while voice is off.** It is how the user turns voice on and how `shutup` works.
- **Run `npm run build` before any manual hook verification.** Hooks execute `dist/cli.js`, not `src/`.
- **Verification is task-scoped for Tasks 1–6, whole-suite for Tasks 7–9.** Tasks 1–6 deliberately leave the full suite red: `session.ts` removes exports that `cli.ts` and `subcommands.ts` still import, and Task 7 repairs it. For Tasks 1–6 the passing gate is the task's own `npx vitest run test/<file>` command, stated in that task's Step 2 and Step 4. `npm test && npm run typecheck` must pass at Task 7 and again at Task 9. A red full suite during Tasks 1–6 is expected and is not a defect; a red *task-scoped* suite is.
- **The synthesize → stop-epoch-guard → playAudio sequence is intentionally duplicated** between `speakText()` and `run()`. That duplication is pre-existing in `cli.ts`; this change adds the guard to both copies rather than extracting a shared helper, to keep the diff scoped to the three features. Extracting it is a known deferred cleanup, not part of this plan.

---

### Task 1: Per-session state (`session.ts` rewrite)

Replaces the global `muted` boolean with per-session-ID activation files. This is the foundation every later task consumes.

**Files:**
- Modify (full rewrite): `src/session.ts`
- Test (full rewrite): `test/session.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  ```ts
  export interface SessionState {
    active: boolean;
    activatedAt: number;
    spokeThisTurn: boolean;
  }
  export function resolveSessionId(stdin?: string): string | null;
  export function getSessionsDir(): string;
  export function getSessionPath(sessionId: string): string;
  export function loadSessionState(sessionId: string): SessionState | null;
  export function isActive(sessionId: string | null): boolean;
  export function activate(sessionId: string): void;
  export function deactivate(sessionId: string): void;
  export function setSpokeThisTurn(sessionId: string, value: boolean): void;
  export function consumeSpokeThisTurn(sessionId: string): boolean;
  export function gcSessions(maxAgeMs?: number): void;
  ```
  The old exports `loadSession`, `writeSession`, `clearSession`, and `SESSION_DEFAULTS` are **removed**. `getSessionPath` changes from zero-arg to taking a session ID.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `test/session.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL — `resolveSessionId is not a function` and similar missing-export errors.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `src/session.ts`:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SessionState {
  active: boolean;
  activatedAt: number;
  spokeThisTurn: boolean;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function getSessionsDir(): string {
  return path.join(os.homedir(), '.claude-speak', 'sessions');
}

export function getSessionPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

/**
 * Resolve the current Claude Code session id.
 *
 * Hook stdin is authoritative because it is supplied by the harness for the
 * exact session firing the hook. The env var covers the Bash-tool path, where
 * there is no hook payload. When neither is available we return null rather
 * than falling back to a shared key — a shared key would reintroduce the
 * cross-session leakage this design removes.
 */
export function resolveSessionId(stdin?: string): string | null {
  if (stdin) {
    try {
      const parsed = JSON.parse(stdin) as Record<string, unknown>;
      if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
        return parsed.session_id;
      }
    } catch {
      // Fall through to the environment.
    }
  }

  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
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

function writeSessionState(sessionId: string, state: SessionState): void {
  const filePath = getSessionPath(sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/session.test.ts`
Expected: PASS, all tests.

Note: `npm test` and `npm run typecheck` will still fail at this point because `cli.ts` and `subcommands.ts` import the removed `loadSession`. That is expected and is repaired in Tasks 6 and 7. Do not "fix" it by reintroducing the old API.

- [ ] **Step 5: Commit**

```bash
git add src/session.ts test/session.test.ts
git commit -m "feat!: replace global mute state with per-session activation files

Voice activation is now the existence of
~/.claude-speak/sessions/<session_id>.json. Adds resolveSessionId with
stdin-over-env precedence, a spokeThisTurn turn flag for exact Stop-hook
dedup, and GC of stale sessions plus the legacy 1.x session.json.

Callers are updated in later commits.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `speech` config block

Adds the shared configuration contract that the condenser, summarizer, and CLI all read.

**Files:**
- Modify: `src/config.ts` (interface near line 13, `getSharedDefaults` at line 58, `loadConfig` return at line 140)
- Test: `test/config.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface SummarizerConfig {
    model: string;
    timeout: number;   // seconds
    maxWords: number;
  }
  export interface SpeechConfig {
    maxChars: number;
    condense: boolean;
    summarizer: SummarizerConfig;
  }
  // VoiceConfig gains:  speech: SpeechConfig
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.ts`, inside the existing top-level `describe`:

```ts
  describe('speech config', () => {
    it('supplies speech defaults when no config file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig();
      expect(config.speech.maxChars).toBe(500);
      expect(config.speech.condense).toBe(true);
      expect(config.speech.summarizer.model).toBe('gpt-5.4-nano-2026-03-17');
      expect(config.speech.summarizer.timeout).toBe(8);
      expect(config.speech.summarizer.maxWords).toBe(40);
    });

    it('overrides speech defaults from the config file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          activeProvider: 'openai',
          providers: { openai: { model: 'm', voice: 'ash', speed: 1 } },
          speech: { maxChars: 200, condense: false },
        }),
      );
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig();
      expect(config.speech.maxChars).toBe(200);
      expect(config.speech.condense).toBe(false);
    });

    it('merges a partial summarizer block over its defaults', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          activeProvider: 'openai',
          providers: { openai: { model: 'm', voice: 'ash', speed: 1 } },
          speech: { summarizer: { timeout: 3 } },
        }),
      );
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig();
      expect(config.speech.summarizer.timeout).toBe(3);
      expect(config.speech.summarizer.model).toBe('gpt-5.4-nano-2026-03-17');
      expect(config.speech.summarizer.maxWords).toBe(40);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'maxChars')`.

- [ ] **Step 3: Implement**

In `src/config.ts`, add the interfaces above the existing `VoiceConfig` interface:

```ts
export interface SummarizerConfig {
  model: string;
  timeout: number;
  maxWords: number;
}

export interface SpeechConfig {
  maxChars: number;
  condense: boolean;
  summarizer: SummarizerConfig;
}
```

Add `speech: SpeechConfig;` to `VoiceConfig`, immediately after the `playback` field.

In `getSharedDefaults()`, add to the returned object:

```ts
    speech: {
      maxChars: 500,
      condense: true,
      summarizer: {
        model: 'gpt-5.4-nano-2026-03-17',
        timeout: 8,
        maxWords: 40,
      },
    },
```

In `loadConfig()`, add this immediately before the final `return` statement:

```ts
  const rawSpeech = (fileConfig.speech as Record<string, unknown>) ?? {};
  const rawSummarizer = (rawSpeech.summarizer as Record<string, unknown>) ?? {};
  const speech: SpeechConfig = {
    maxChars: (rawSpeech.maxChars as number) ?? shared.speech.maxChars,
    condense: (rawSpeech.condense as boolean) ?? shared.speech.condense,
    summarizer: {
      model: (rawSummarizer.model as string) ?? shared.speech.summarizer.model,
      timeout: (rawSummarizer.timeout as number) ?? shared.speech.summarizer.timeout,
      maxWords: (rawSummarizer.maxWords as number) ?? shared.speech.summarizer.maxWords,
    },
  };
```

Then add `speech,` to that `return` object's properties.

The `defaultConfig` object already spreads `...shared`, so the no-file path needs no change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add speech config block for condensation and summarizer

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Condenser (pure detection + heuristic floor)

Decides whether a message is unlistenable, and provides the deterministic last-resort condensation.

**Files:**
- Create: `src/condenser.ts`
- Create: `test/condenser.test.ts`

**Interfaces:**
- Consumes: `sanitize` from `src/sanitizer.ts` (existing, unchanged).
- Produces:
  ```ts
  export function shouldCondense(raw: string, maxChars: number): boolean;
  export function heuristicCondense(raw: string, maxChars: number): string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/condenser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldCondense, heuristicCondense } from '../src/condenser.js';
import { sanitize } from '../src/sanitizer.js';

describe('shouldCondense', () => {
  it('is false for a short plain-prose message', () => {
    expect(shouldCondense('Done. All tests pass.', 500)).toBe(false);
  });

  it('is true when a markdown table is present, however short', () => {
    const raw = 'Done.\n\n| File | Status |\n|---|---|\n| a.ts | ok |\n';
    expect(shouldCondense(raw, 500)).toBe(true);
  });

  it('is true when a fenced code block is present', () => {
    expect(shouldCondense('Run this:\n\n```bash\nnpm test\n```\n', 500)).toBe(true);
  });

  it('is true at five list items', () => {
    const raw = '- one\n- two\n- three\n- four\n- five\n';
    expect(shouldCondense(raw, 500)).toBe(true);
  });

  it('is false at four list items', () => {
    const raw = '- one\n- two\n- three\n- four\n';
    expect(shouldCondense(raw, 500)).toBe(false);
  });

  it('counts numbered list items too', () => {
    const raw = '1. one\n2. two\n3. three\n4. four\n5. five\n';
    expect(shouldCondense(raw, 500)).toBe(true);
  });

  it('is true when sanitized length exceeds maxChars', () => {
    expect(shouldCondense('word '.repeat(200), 500)).toBe(true);
  });

  it('measures length after sanitizing, not before', () => {
    // Bold markers push the RAW length over the threshold while the spoken
    // text stays under it. This must not trigger condensation.
    // raw = (2 + 48 + 2) * 2 + 1 space = 105 chars, over the 100 threshold.
    // sanitized = 48 + 1 + 48 = 97 chars, under it.
    const spoken = 'a'.repeat(48);
    const raw = `**${spoken}** **${spoken}**`;
    expect(raw.length).toBeGreaterThan(100);
    expect(sanitize(raw).length).toBeLessThanOrEqual(100);
    expect(shouldCondense(raw, 100)).toBe(false);
  });
});

describe('heuristicCondense', () => {
  it('drops table blocks entirely', () => {
    const raw = 'Finished.\n\n| File | Status |\n|---|---|\n| a.ts | ok |\n\nAll good.';
    const out = heuristicCondense(raw, 500);
    expect(out).not.toContain('a.ts');
    expect(out).not.toContain('|');
  });

  it('drops fenced code blocks including their contents', () => {
    const raw = 'Run:\n\n```bash\nnpm test --coverage\n```\n\nThen review.';
    const out = heuristicCondense(raw, 500);
    expect(out).not.toContain('npm test');
    expect(out).not.toContain('```');
  });

  it('keeps the first three list items and summarizes the rest', () => {
    const raw = '- one\n- two\n- three\n- four\n- five\n- six\n';
    const out = heuristicCondense(raw, 500);
    expect(out).toContain('one');
    expect(out).toContain('three');
    expect(out).not.toContain('five');
    expect(out).toContain('and 3 more');
  });

  it('does not add a "more" note when there are three or fewer items', () => {
    const out = heuristicCondense('- one\n- two\n', 500);
    expect(out).not.toContain('more');
  });

  it('truncates on a sentence boundary, never mid-word', () => {
    const raw = 'First sentence here. Second sentence here. Third sentence here.';
    const out = heuristicCondense(raw, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toMatch(/\.$/);
    expect(out).toBe('First sentence here.');
  });

  it('falls back to a word boundary when no sentence break fits', () => {
    const out = heuristicCondense('alpha beta gamma delta epsilon zeta', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toMatch(/\w$/);
  });

  it('keeps the first and last paragraph, dropping the middle', () => {
    const raw = 'Opening line.\n\nMiddle noise here.\n\nClosing line.';
    const out = heuristicCondense(raw, 500);
    expect(out).toContain('Opening line.');
    expect(out).toContain('Closing line.');
    expect(out).not.toContain('Middle noise');
  });

  it('returns an empty string for input that is entirely a table', () => {
    const raw = '| File | Status |\n|---|---|\n| a.ts | ok |\n';
    expect(heuristicCondense(raw, 500).trim()).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/condenser.test.ts`
Expected: FAIL — cannot resolve `../src/condenser.js`.

- [ ] **Step 3: Implement**

Create `src/condenser.ts`:

```ts
import { sanitize } from './sanitizer.js';

const TABLE_SEPARATOR = /^\|?\s*[-:]+\s*\|/;
const LIST_ITEM = /^\s*(?:[-*]\s+|\d+\.\s+)/;

function hasTable(text: string): boolean {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('|') && TABLE_SEPARATOR.test(lines[i + 1])) return true;
  }
  return false;
}

function hasCodeFence(text: string): boolean {
  return /^```/m.test(text);
}

function countListItems(text: string): number {
  return text.split('\n').filter((line) => LIST_ITEM.test(line)).length;
}

/**
 * Structured content always triggers condensation regardless of length: a
 * three-line message containing a table is the core problem case. Plain prose
 * gets the maxChars allowance, measured after sanitizing so that markdown
 * syntax does not count against the spoken budget.
 */
export function shouldCondense(raw: string, maxChars: number): boolean {
  if (!raw) return false;
  if (hasTable(raw)) return true;
  if (hasCodeFence(raw)) return true;
  if (countListItems(raw) >= 5) return true;
  return sanitize(raw).length > maxChars;
}

function stripCodeFences(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n');
}

function stripTables(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const isTableStart =
      lines[i].includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]);
    if (isTableStart) {
      i += 2;
      while (i < lines.length && lines[i].includes('|')) i++;
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  return kept.join('\n');
}

function collapseLists(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!LIST_ITEM.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const items: string[] = [];
    while (i < lines.length && LIST_ITEM.test(lines[i])) {
      items.push(lines[i]);
      i++;
    }
    out.push(...items.slice(0, 3));
    if (items.length > 3) out.push(`and ${items.length - 3} more`);
  }
  return out.join('\n');
}

function keepFirstAndLastParagraph(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length <= 2) return paragraphs.join('\n\n');
  return [paragraphs[0], paragraphs[paragraphs.length - 1]].join('\n\n');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const window = text.slice(0, maxChars);

  const lastSentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.endsWith('.') ? window.length - 1 : -1,
  );
  if (lastSentence > 0) return window.slice(0, lastSentence + 1).trim();

  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > 0) return window.slice(0, lastSpace).trim() + ' ';

  return window;
}

/**
 * Deterministic last-resort condensation, used when the LLM rewrite is
 * unavailable. Extractive only: it can cut, never synthesize.
 */
export function heuristicCondense(raw: string, maxChars: number): string {
  if (!raw) return '';
  let result = stripCodeFences(raw);
  result = stripTables(result);
  result = collapseLists(result);
  result = keepFirstAndLastParagraph(result);
  return truncate(result.trim(), maxChars);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/condenser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/condenser.ts test/condenser.test.ts
git commit -m "feat: add condenser for detection and heuristic condensation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Summarizer (LLM rewrite) and `logWarning`

The tier-2 fallback. Adds a non-beeping log helper first, because a summarizer timeout is routine and must not trigger the audible error sound.

**Files:**
- Modify: `src/error.ts`
- Create: `src/summarizer.ts`
- Create: `test/summarizer.test.ts`
- Test: `test/error.test.ts` (append one test)

**Interfaces:**
- Consumes: `VoiceConfig` from `src/config.ts` (Task 2 — needs `config.speech.summarizer` and `config.apiKeys.openai`).
- Produces:
  ```ts
  export function logWarning(message: string, logFile: string): void;  // in error.ts
  export function summarizeForSpeech(raw: string, config: VoiceConfig): Promise<string | null>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/summarizer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { summarizeForSpeech } from '../src/summarizer.js';
import type { VoiceConfig } from '../src/config.js';

vi.mock('../src/error.js');

function makeConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    enabled: true,
    activeProvider: 'openai',
    providers: { openai: { model: 'tts', voice: 'ash', speed: 1.0 } },
    apiKeys: { openai: 'sk-test', elevenlabs: null },
    hooks: { stop: true, notification: true },
    playback: { command: 'afplay' },
    speech: {
      maxChars: 500,
      condense: true,
      summarizer: { model: 'gpt-5.4-nano-2026-03-17', timeout: 8, maxWords: 40 },
    },
    cooldown: 15,
    timeout: 30,
    logFile: '/tmp/voice.log',
    ...overrides,
  } as VoiceConfig;
}

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

describe('summarizeForSpeech', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the rewritten text on success', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('Fixed three bugs. All tests pass.') as never);
    const result = await summarizeForSpeech('a long message', makeConfig());
    expect(result).toBe('Fixed three bugs. All tests pass.');
  });

  it('sends the configured model', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('short') as never);
    await summarizeForSpeech('a long message', makeConfig());
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.model).toBe('gpt-5.4-nano-2026-03-17');
  });

  it('sends the api key as a bearer token', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('short') as never);
    await summarizeForSpeech('a long message', makeConfig());
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('returns null when no openai key is configured', async () => {
    const config = makeConfig({ apiKeys: { openai: null, elevenlabs: 'x' } });
    const result = await summarizeForSpeech('a long message', config);
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null on a non-200 response', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429, json: async () => ({}) } as never);
    expect(await summarizeForSpeech('a long message', makeConfig())).toBeNull();
  });

  it('returns null when fetch rejects (timeout or network failure)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('The operation was aborted'));
    expect(await summarizeForSpeech('a long message', makeConfig())).toBeNull();
  });

  it('returns null on a malformed response body', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: true }),
    } as never);
    expect(await summarizeForSpeech('a long message', makeConfig())).toBeNull();
  });

  it('returns null on empty content', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('   ') as never);
    expect(await summarizeForSpeech('a long message', makeConfig())).toBeNull();
  });

  it('passes an abort signal so the timeout can fire', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('short') as never);
    await summarizeForSpeech('a long message', makeConfig());
    expect(vi.mocked(fetch).mock.calls[0][1]!.signal).toBeDefined();
  });
});
```

Append to `test/error.test.ts`, inside the existing top-level `describe`:

```ts
  describe('logWarning', () => {
    it('writes a WARN line and never plays a sound', async () => {
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.appendFileSync).mockReturnValue(undefined);
      const { logWarning } = await import('../src/error.js');

      logWarning('summarizer timed out', '/tmp/voice.log');

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        '/tmp/voice.log',
        expect.stringContaining('WARN: summarizer timed out'),
      );
      expect(child_process.spawnSync).not.toHaveBeenCalled();
    });
  });
```

If `test/error.test.ts` does not already import `child_process` and mock it, add `import * as child_process from 'node:child_process';` and `vi.mock('node:child_process');` at the top alongside the existing mocks.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/summarizer.test.ts test/error.test.ts`
Expected: FAIL — cannot resolve `../src/summarizer.js`; `logWarning is not a function`.

- [ ] **Step 3: Implement**

Append to `src/error.ts`:

```ts
/**
 * Log a non-fatal warning. Unlike handleError, this never plays a sound:
 * summarizer fallbacks are routine and must not beep at the user.
 */
export function logWarning(message: string, logFile: string): void {
  try {
    const timestamp = new Date().toISOString();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${timestamp}] WARN: ${message}\n`);
  } catch {
    // Logging is best effort.
  }
}
```

Create `src/summarizer.ts`:

```ts
import type { VoiceConfig } from './config.js';
import { logWarning } from './error.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

function buildSystemPrompt(maxWords: number): string {
  return [
    'Rewrite this message to be heard, not read.',
    `Two sentences maximum, under ${maxWords} words.`,
    'State the outcome and the single number that matters most.',
    'No markdown, no file paths, no lists.',
    'If the input was a table of results, say how many there were and whether they passed.',
    'Reply with only the rewritten text.',
  ].join(' ');
}

/**
 * Tier 2 of the condensation chain: an LLM rewrite of a message that is too
 * long or too structured to speak verbatim.
 *
 * Returns null on any failure so the caller can fall back to the deterministic
 * heuristic. Never throws.
 *
 * Deliberately sends no temperature and no token cap: the target model family
 * varies in which of those parameters it accepts, and a rejected parameter
 * would fail every request. Length is controlled by the prompt instead.
 */
export async function summarizeForSpeech(
  raw: string,
  config: VoiceConfig,
): Promise<string | null> {
  const apiKey = config.apiKeys.openai;
  if (!apiKey) {
    logWarning('summarizer skipped: no OpenAI API key configured', config.logFile);
    return null;
  }

  const { model, timeout, maxWords } = config.speech.summarizer;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt(maxWords) },
          { role: 'user', content: raw },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logWarning(`summarizer failed: HTTP ${response.status}`, config.logFile);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      logWarning('summarizer failed: empty or malformed response', config.logFile);
      return null;
    }

    return content.trim();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logWarning(`summarizer failed: ${reason}`, config.logFile);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/summarizer.test.ts test/error.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/summarizer.ts src/error.ts test/summarizer.test.ts test/error.test.ts
git commit -m "feat: add LLM summarizer with quiet warning logging

Adds logWarning alongside handleError so routine summarizer fallbacks
do not trigger the audible error beep.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Playback PID tracking and stop

Makes the detached audio process addressable, and adds the stop-epoch that closes the mid-synthesis race.

**Files:**
- Modify: `src/player.ts`
- Test: `test/player.test.ts` (append describe blocks)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  ```ts
  export function playAudio(audio: Buffer, command: string): void;  // unchanged signature
  export function stopPlayback(): void;
  export function readStopEpoch(): number;   // 0 when never stopped
  export function getPlaybackPath(): string;
  export function getStopEpochPath(): string;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `test/player.test.ts`. First extend the top-level mocks with `os`:

```ts
import * as os from 'node:os';
vi.mock('node:os');
```

In the existing `beforeEach`, add `vi.spyOn(os, 'homedir').mockReturnValue('/mock/home');` and `vi.mocked(os.tmpdir).mockReturnValue('/tmp');`.

Then append these describe blocks:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/player.test.ts`
Expected: FAIL — `stopPlayback is not a function`; no `playback.json` write.

- [ ] **Step 3: Implement**

Replace the entire contents of `src/player.ts`:

```ts
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Playback state is machine-global, not per-session: there is one audio
 * device, and a stop request must silence whatever is playing regardless of
 * which session started it.
 */
function stateDir(): string {
  return path.join(os.homedir(), '.claude-speak');
}

export function getPlaybackPath(): string {
  return path.join(stateDir(), 'playback.json');
}

export function getStopEpochPath(): string {
  return path.join(stateDir(), 'stop-epoch');
}

function clearPlaybackFile(): void {
  const filePath = getPlaybackPath();
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best effort.
  }
}

export function playAudio(audio: Buffer, command: string): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-speak-'));
  const filePath = path.join(tmpDir, 'output.mp3');
  fs.writeFileSync(filePath, audio);

  const child = spawn(command, [filePath], {
    detached: true,
    stdio: 'ignore',
  });

  if (child.pid) {
    try {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(
        getPlaybackPath(),
        JSON.stringify({ pid: child.pid, startedAt: Date.now() }, null, 2),
        'utf-8',
      );
    } catch {
      // Losing the pid file only costs interruptibility, not playback.
    }
  }

  child.on('exit', () => {
    clearPlaybackFile();
    try {
      fs.unlinkSync(filePath);
      fs.rmdirSync(tmpDir);
    } catch {
      // best effort cleanup
    }
  });

  child.unref();
}

/**
 * Silence any in-flight playback.
 *
 * The epoch is stamped before the kill so that a synthesis finishing in the
 * same instant still observes the stop request and discards its audio.
 */
export function stopPlayback(): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(getStopEpochPath(), String(Date.now()), 'utf-8');
  } catch {
    // Best effort.
  }

  const filePath = getPlaybackPath();
  if (!fs.existsSync(filePath)) return;

  try {
    const { pid } = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { pid?: number };
    if (typeof pid === 'number') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ESRCH: the process already exited. Nothing to do.
      }
    }
  } catch {
    // Corrupt pid file: fall through to cleanup.
  }

  clearPlaybackFile();
}

export function readStopEpoch(): number {
  const filePath = getStopEpochPath();
  if (!fs.existsSync(filePath)) return 0;
  try {
    const value = Number(fs.readFileSync(filePath, 'utf-8'));
    return Number.isNaN(value) ? 0 : value;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/player.test.ts`
Expected: PASS, including the three pre-existing `playAudio` tests.

- [ ] **Step 5: Commit**

```bash
git add src/player.ts test/player.test.ts
git commit -m "feat: track playback pid and add stopPlayback with a stop epoch

The epoch is stamped before the kill so a synthesis completing during the
stop request can detect it and discard its audio rather than starting
playback after the user asked for silence.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Subcommands (`on`, `off`, `stop`, `turn-start`)

**Files:**
- Modify: `src/subcommands.ts`
- Test: `test/subcommands.test.ts`

**Interfaces:**
- Consumes: `activate`, `deactivate`, `isActive`, `setSpokeThisTurn` from Task 1; `stopPlayback` from Task 5.
- Produces:
  ```ts
  export function dispatch(
    cmd: string,
    args: string[],
    sessionId: string | null,
  ): Promise<SubcommandResult>;
  ```
  `SubcommandResult` is unchanged. `dispatch` gains a third parameter — Task 7 updates the caller.

- [ ] **Step 1: Write the failing tests**

Append to `test/subcommands.test.ts`. Ensure the file mocks the new modules at the top:

```ts
vi.mock('../src/session.js');
vi.mock('../src/player.js');
```

with `import * as session from '../src/session.js';` and `import * as player from '../src/player.js';`.

```ts
describe('activation subcommands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('on activates the resolved session', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('on', [], 'sess-1');
    expect(session.activate).toHaveBeenCalledWith('sess-1');
    expect(result.error).toBeFalsy();
  });

  it('on reports an error and does not activate when the session id is unknown', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('on', [], null);
    expect(result.error).toBe(true);
    expect(session.activate).not.toHaveBeenCalled();
  });

  it('off deactivates the session', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('off', [], 'sess-1');
    expect(session.deactivate).toHaveBeenCalledWith('sess-1');
  });

  it('off succeeds without error when the session id is unknown', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('off', [], null);
    expect(result.error).toBeFalsy();
    expect(session.deactivate).not.toHaveBeenCalled();
  });

  it('mute is an alias for off', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('mute', [], 'sess-1');
    expect(session.deactivate).toHaveBeenCalledWith('sess-1');
  });

  it('unmute is an alias for on', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('unmute', [], 'sess-1');
    expect(session.activate).toHaveBeenCalledWith('sess-1');
  });

  it('on requests a spoken confirmation, so the user hears that it worked', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('on', [], 'sess-1');
    expect(result.speak).toBe(true);
  });

  it('off does not request speech', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('off', [], 'sess-1');
    expect(result.speak).toBe(false);
  });
});

describe('stop and turn-start subcommands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stop silences playback and never speaks', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('stop', [], 'sess-1');
    expect(player.stopPlayback).toHaveBeenCalled();
    expect(result.speak).toBe(false);
  });

  it('stop works even when the session id is unknown', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('stop', [], null);
    expect(player.stopPlayback).toHaveBeenCalled();
    expect(result.error).toBeFalsy();
  });

  it('turn-start silences playback and clears the turn flag', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    await dispatch('turn-start', [], 'sess-1');
    expect(player.stopPlayback).toHaveBeenCalled();
    expect(session.setSpokeThisTurn).toHaveBeenCalledWith('sess-1', false);
  });

  it('turn-start emits no output, so it cannot pollute the prompt', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('turn-start', [], 'sess-1');
    expect(result.message).toBe('');
    expect(result.speak).toBe(false);
  });
});

describe('status output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the session as active when it is', async () => {
    vi.mocked(session.isActive).mockReturnValue(true);
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('status', [], 'sess-1');
    expect(result.message).toContain('Voice: active');
  });

  it('reports the session as off when inactive', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('status', [], 'sess-1');
    expect(result.message).toContain('Voice: off');
  });

  it('reports an unresolved session id explicitly', async () => {
    const { dispatch } = await import('../src/subcommands.js');
    const result = await dispatch('status', [], null);
    expect(result.message).toContain('Session: unknown');
  });
});
```

Existing tests in this file that call `dispatch(cmd, args)` with two arguments must be updated to pass a third argument (`'sess-1'`). Update them mechanically; do not change their assertions.

The `status` tests exercise `handleStatus`, which now reads `config.speech.condense` and `config.speech.maxChars`. Whatever config mock this file already uses must include a `speech` block, or those tests throw on `undefined.condense`. Use the same shape as Task 2's defaults:

```ts
speech: {
  maxChars: 500,
  condense: true,
  summarizer: { model: 'gpt-5.4-nano-2026-03-17', timeout: 8, maxWords: 40 },
},
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/subcommands.test.ts`
Expected: FAIL — `Unknown command "on"`.

- [ ] **Step 3: Implement**

In `src/subcommands.ts`:

Replace the `loadSession, writeSession` import with:

```ts
import { activate, deactivate, isActive, setSpokeThisTurn } from './session.js';
import { stopPlayback } from './player.js';
```

Update the command list constant:

```ts
const AVAILABLE_COMMANDS = [
  'on', 'off', 'mute', 'unmute', 'provider', 'speed', 'voice', 'voices', 'status', 'test',
];
```

`stop` and `turn-start` are intentionally absent from this list: they are internal entry points for `bin/shutup` and the `UserPromptSubmit` hook, not commands to advertise in the usage message.

Replace `handleMute` and `handleUnmute` with:

```ts
async function handleOn(sessionId: string | null): Promise<SubcommandResult> {
  if (!sessionId) {
    return {
      message:
        'Cannot determine the current session. Voice not activated. ' +
        'This usually means CLAUDE_CODE_SESSION_ID is unavailable — try restarting Claude Code.',
      speak: false,
      error: true,
    };
  }
  activate(sessionId);
  return { message: 'Voice output activated for this session.', speak: true };
}

async function handleOff(sessionId: string | null): Promise<SubcommandResult> {
  if (sessionId) deactivate(sessionId);
  return { message: 'Voice output off for this session.', speak: false };
}

async function handleStop(): Promise<SubcommandResult> {
  stopPlayback();
  return { message: '', speak: false };
}

async function handleTurnStart(sessionId: string | null): Promise<SubcommandResult> {
  stopPlayback();
  if (sessionId) setSpokeThisTurn(sessionId, false);
  return { message: '', speak: false };
}
```

`handleOff` does not error on a null session id: the desired end state (silence) already holds.

Replace `handleStatus` with a version taking the session id:

```ts
async function handleStatus(sessionId: string | null): Promise<SubcommandResult> {
  const config = loadConfig();
  const provider = config.activeProvider;
  const providerConfig = config.providers[provider];

  const lines = [
    `Session: ${sessionId ?? 'unknown'}`,
    `Voice: ${isActive(sessionId) ? 'active' : 'off'}`,
    `Provider: ${provider}`,
    `Voice name: ${providerConfig?.voice ?? '(not set)'}`,
    `Speed: ${providerConfig?.speed ?? 1.0}`,
    `Condense: ${config.speech.condense} (over ${config.speech.maxChars} chars)`,
    `Hooks: stop=${config.hooks.stop}, notification=${config.hooks.notification}`,
  ];

  return { message: lines.join('\n'), speak: false };
}
```

Update `dispatch`:

```ts
export async function dispatch(
  cmd: string,
  args: string[],
  sessionId: string | null,
): Promise<SubcommandResult> {
  switch (cmd) {
    case 'on':
    case 'unmute':
      return handleOn(sessionId);
    case 'off':
    case 'mute':
      return handleOff(sessionId);
    case 'stop':
      return handleStop();
    case 'turn-start':
      return handleTurnStart(sessionId);
    case 'provider':
      return handleProvider(args);
    case 'speed':
      return handleSpeed(args);
    case 'voice':
      return handleVoice(args);
    case 'voices':
      return handleVoices();
    case 'status':
      return handleStatus(sessionId);
    case 'test':
      return handleTest();
    default:
      return {
        message: `Unknown command "${cmd}". Available: ${AVAILABLE_COMMANDS.join(', ')}`,
        speak: false,
        error: true,
      };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/subcommands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/subcommands.ts test/subcommands.test.ts
git commit -m "feat!: add on/off/stop/turn-start subcommands

mute and unmute become aliases for off and on. dispatch now takes the
resolved session id. stop and turn-start are internal entry points for
bin/shutup and the UserPromptSubmit hook, so they are not advertised in
the usage message.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Wire the CLI

Connects everything: the activation gate, the condensation stage, the stop-epoch race check, and turn-scoped dedup.

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: all of Tasks 1–6.
- Produces: no new exports. `isIdleNotification` and `run` keep their existing signatures.

- [ ] **Step 1: Write the failing tests**

In `test/cli.test.ts`, update the mock imports to add the new modules:

```ts
import * as condenser from '../src/condenser.js';
import * as summarizer from '../src/summarizer.js';

vi.mock('../src/condenser.js');
vi.mock('../src/summarizer.js');
```

Add `speech` to `makeConfig()`'s returned object:

```ts
    speech: {
      maxChars: 500,
      condense: true,
      summarizer: { model: 'gpt-5.4-nano-2026-03-17', timeout: 8, maxWords: 40 },
    },
```

In the existing `beforeEach`, replace the `session.loadSession` line with:

```ts
    vi.mocked(session.resolveSessionId).mockReturnValue('sess-1');
    vi.mocked(session.isActive).mockReturnValue(true);
    vi.mocked(session.consumeSpokeThisTurn).mockReturnValue(false);
    vi.mocked(condenser.shouldCondense).mockReturnValue(false);
    vi.mocked(player.readStopEpoch).mockReturnValue(0);
```

Existing tests that set `session.loadSession` to `{ muted: true }` to assert silence must be changed to `vi.mocked(session.isActive).mockReturnValue(false)`.

Append these describe blocks:

```ts
describe('activation gate', () => {
  it('speaks nothing on a stop trigger when the session is inactive', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).not.toHaveBeenCalled();
  });

  it('speaks nothing on active voice when the session is inactive', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);

    await run(['--say', 'hello'], '');

    expect(player.playAudio).not.toHaveBeenCalled();
  });

  it('routes --cmd even when the session is inactive, so voice can be turned on', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: 'ok', speak: false });

    await run(['--cmd', 'on'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('on', [], 'sess-1');
  });

  it('routes --cmd stop even when the session is inactive', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: '', speak: false });

    await run(['--cmd', 'stop'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('stop', [], 'sess-1');
  });

  it('does not speak a subcommand confirmation while voice is off', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: 'a test phrase', speak: true });

    await run(['--cmd', 'test'], '');

    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('speaks a subcommand confirmation once voice is active', async () => {
    vi.mocked(session.isActive).mockReturnValue(true);
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: 'a test phrase', speak: true });

    await run(['--cmd', 'test'], '');

    expect(mockSynthesize).toHaveBeenCalledWith('a test phrase', expect.anything());
  });
});

describe('condensation', () => {
  it('uses the LLM rewrite when the message is over threshold', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('a very long message with a table');
    vi.mocked(condenser.shouldCondense).mockReturnValue(true);
    vi.mocked(summarizer.summarizeForSpeech).mockResolvedValue('Two bugs fixed.');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).toHaveBeenCalledWith('Two bugs fixed.', expect.anything());
  });

  it('falls back to the heuristic when the rewrite returns null', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('a very long message with a table');
    vi.mocked(condenser.shouldCondense).mockReturnValue(true);
    vi.mocked(summarizer.summarizeForSpeech).mockResolvedValue(null);
    vi.mocked(condenser.heuristicCondense).mockReturnValue('Finished.');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).toHaveBeenCalledWith('Finished.', expect.anything());
  });

  it('leaves a short message untouched', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('Done.');
    vi.mocked(condenser.shouldCondense).mockReturnValue(false);

    await run(['--trigger', 'stop'], '{}');

    expect(summarizer.summarizeForSpeech).not.toHaveBeenCalled();
    expect(mockSynthesize).toHaveBeenCalledWith('Done.', expect.anything());
  });

  it('never condenses active voice text', async () => {
    vi.mocked(condenser.shouldCondense).mockReturnValue(true);

    await run(['--say', 'A hand written line.'], '');

    expect(summarizer.summarizeForSpeech).not.toHaveBeenCalled();
    expect(mockSynthesize).toHaveBeenCalledWith('A hand written line.', expect.anything());
  });

  it('skips condensation entirely when disabled in config', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({
      speech: {
        maxChars: 500,
        condense: false,
        summarizer: { model: 'm', timeout: 8, maxWords: 40 },
      },
    }));
    vi.mocked(extractor.extractMessage).mockReturnValue('a very long message');
    vi.mocked(condenser.shouldCondense).mockReturnValue(true);

    await run(['--trigger', 'stop'], '{}');

    expect(summarizer.summarizeForSpeech).not.toHaveBeenCalled();
    expect(mockSynthesize).toHaveBeenCalledWith('a very long message', expect.anything());
  });
});

describe('stop during synthesis', () => {
  it('discards audio when a stop was requested after synthesis began', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');
    // Synthesis resolves, but a stop landed while it was in flight.
    mockSynthesize.mockImplementation(async () => {
      vi.mocked(player.readStopEpoch).mockReturnValue(Date.now() + 1000);
      return Buffer.from('audio');
    });

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).not.toHaveBeenCalled();
  });

  it('plays audio when no stop was requested', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');
    vi.mocked(player.readStopEpoch).mockReturnValue(0);

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).toHaveBeenCalled();
  });
});

describe('turn-scoped dedup', () => {
  it('suppresses the stop hook when active voice already spoke this turn', async () => {
    vi.mocked(session.consumeSpokeThisTurn).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).not.toHaveBeenCalled();
  });

  it('speaks on the stop hook when nothing spoke this turn', async () => {
    vi.mocked(session.consumeSpokeThisTurn).mockReturnValue(false);
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).toHaveBeenCalled();
  });

  it('speaks on a second consecutive stop hook, since the flag was consumed', async () => {
    vi.mocked(session.consumeSpokeThisTurn).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');
    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).toHaveBeenCalledTimes(1);
  });

  it('marks the turn as spoken on active voice', async () => {
    await run(['--say', 'hello'], '');
    expect(session.setSpokeThisTurn).toHaveBeenCalledWith('sess-1', true);
  });

  it('still uses the cooldown lock for notification triggers', async () => {
    vi.mocked(lock.isLocked).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('a notification');

    await run(['--trigger', 'notification'], '{}');

    expect(player.playAudio).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `session.loadSession is not a function` or equivalent, plus the new assertions.

- [ ] **Step 3: Implement**

In `src/cli.ts`:

Replace the `session` import:

```ts
import {
  resolveSessionId,
  isActive,
  setSpokeThisTurn,
  consumeSpokeThisTurn,
} from './session.js';
import { shouldCondense, heuristicCondense } from './condenser.js';
import { summarizeForSpeech } from './summarizer.js';
import { playAudio, readStopEpoch } from './player.js';
```

Remove the existing `import { playAudio } from './player.js';` line to avoid a duplicate import.

Add a helper above `run`:

```ts
/**
 * Condense passive-path text that is too long or too structured to speak.
 *
 * Tier order: LLM rewrite, then the deterministic heuristic. Never returns the
 * raw text once shouldCondense has said it is unlistenable.
 */
async function condenseForSpeech(text: string, config: VoiceConfig): Promise<string> {
  if (!config.speech.condense) return text;
  if (!shouldCondense(text, config.speech.maxChars)) return text;

  debug('condensing: over threshold');
  const rewritten = await summarizeForSpeech(text, config);
  if (rewritten) return rewritten;

  debug('condensing: summarizer unavailable, using heuristic');
  return heuristicCondense(text, config.speech.maxChars);
}
```

Add a stop-epoch guard helper:

```ts
/**
 * Synthesis takes 1-2 seconds. A stop request arriving in that window would
 * otherwise kill a pid that does not exist yet, and audio would begin after
 * the user asked for silence.
 */
function stopRequestedSince(requestedAt: number): boolean {
  return readStopEpoch() > requestedAt;
}
```

In `speakText`, wrap the synthesis call:

```ts
    const requestedAt = Date.now();
    // Keep the existing options object exactly as it is today — voice, model,
    // instructions, speed, voiceId, stability, similarityBoost, style.
    const audio = await provider.synthesize(sanitized, { /* existing options, unchanged */ });

    if (stopRequestedSince(requestedAt)) {
      debug('EXIT: stop requested during synthesis');
      return;
    }

    playAudio(audio, config.playback.command);
```

In `run`, resolve the session id immediately after loading config:

```ts
  const sessionId = resolveSessionId(stdin);
  debug(`sessionId=${sessionId}`);
```

Delete the `const session = loadSession();` line.

In the `--cmd` block, pass the session id and drop the mute special-casing:

```ts
    const result = await dispatch(subCmd, subArgs, sessionId);
    if (result.message) process.stdout.write(result.message + '\n');
    // Subcommand confirmations obey the activation gate like everything else.
    // `on` still confirms audibly because handleOn activates before returning.
    if (result.speak && result.message && isActive(sessionId)) {
      const freshConfig = loadConfig();
      await speakText(result.message, freshConfig);
    }
    return;
```

The old `!session.muted || subCmd === 'unmute'` special case is replaced by a plain `isActive(sessionId)` check, which needs no exception list. `handleOn` calls `activate()` before returning, so the session is already active by the time this line runs and the confirmation is spoken. Every other speaking subcommand (`test`, `speed`, `voice`) correctly stays silent while voice is off.

Replace the mute check with the activation gate, in the same position:

```ts
  if (!isActive(sessionId)) { debug('EXIT: session not active'); return; }
```

In the `--say` branch, mark the turn:

```ts
  if (sayIndex !== -1 && args[sayIndex + 1]) {
    writeLock(getLockPath());
    if (sessionId) setSpokeThisTurn(sessionId, true);
    text = args[sayIndex + 1];
    isActiveVoice = true;
  }
```

In the `--trigger` branch, split dedup by trigger type:

```ts
    const triggerType = args[triggerIndex + 1] as 'stop' | 'notification';
    if (!config.hooks[triggerType]) return;

    if (triggerType === 'stop') {
      // Exact, turn-scoped dedup. Always consumes the flag.
      if (sessionId && consumeSpokeThisTurn(sessionId)) {
        debug('EXIT: active voice already spoke this turn');
        return;
      }
    } else {
      // Notifications are not turn-scoped — several can fire in one turn — so
      // the cooldown lock remains the right rate limiter here.
      const lockPath = getLockPath();
      if (isLocked(lockPath, config.cooldown)) { debug('EXIT: locked'); return; }
    }

    text = extractMessage(stdin);
    debug(`extracted text=${text ? text.slice(0, 100) : 'null'}`);

    if (triggerType === 'notification' && text && isIdleNotification(text)) {
      debug('EXIT: filtered idle notification');
      return;
    }
```

After `if (!text) { ... return; }` and before the API-key check, add condensation — passive path only:

```ts
  if (!isActiveVoice) {
    text = await condenseForSpeech(text, config);
    if (!text) { debug('EXIT: condensed to nothing'); return; }
  }
```

Finally, in the inline TTS block at the end of `run`, apply the same stop-epoch guard used in `speakText`:

```ts
    const requestedAt = Date.now();
    // Keep the existing options object exactly as it is today — voice, model,
    // instructions, speed, voiceId, stability, similarityBoost, style.
    const audio = await provider.synthesize(sanitized, { /* existing options, unchanged */ });

    if (stopRequestedSince(requestedAt)) {
      debug('EXIT: stop requested during synthesis');
      return;
    }

    playAudio(audio, config.playback.command);

    if (isActiveVoice) {
      writeLock(getLockPath());
    }
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. This is the first task where the whole suite should be green again.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat!: gate speech on session activation, condense long output

Replaces the global mute check with a per-session activation gate, inserts
condensation before the sanitizer on the passive path only, discards audio
when a stop lands during synthesis, and switches Stop-hook dedup from the
time-based lock to the turn-scoped flag. The cooldown lock still rate
limits notification triggers, which are not turn-scoped.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Hooks, `bin/shutup`, and setup script

Wires the interrupt triggers into the harness. This task has no unit tests; verification is manual and scripted.

**Files:**
- Create: `bin/shutup`
- Modify: `hooks/hooks.json`
- Modify: `scripts/check-setup.sh`
- Modify: `src/subcommands.ts` (adds the `gc` case only — see Step 3)

**Interfaces:**
- Consumes: `--cmd stop` and `--cmd turn-start` from Task 6; `gcSessions` from Task 1.
- Produces: no code interfaces.

- [ ] **Step 1: Create the `shutup` executable**

Create `bin/shutup`:

```sh
#!/bin/sh
# Silence any in-flight claude-speak narration. Fast path: runs directly in the
# shell via `!shutup` at the Claude Code prompt, with no model turn.
ROOT="$(cat "$HOME/.claude-speak/plugin-root" 2>/dev/null)"
[ -n "$ROOT" ] || exit 0
exec node "$ROOT/dist/cli.js" --cmd stop
```

Then:

```bash
chmod +x bin/shutup
```

- [ ] **Step 2: Add the `UserPromptSubmit` hook**

In `hooks/hooks.json`, add this entry alongside the existing `Stop`, `Notification`, and `SessionStart` keys:

```json
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" --cmd turn-start || true"
          }
        ]
      }
    ]
```

The `|| true` is mandatory: a non-zero exit from `UserPromptSubmit` blocks the user's prompt. There is deliberately no `sleep` here — this must not add latency to prompt submission.

- [ ] **Step 3: Update the setup script**

In `scripts/check-setup.sh`:

Remove this line entirely (it is the cause of cross-session unmuting):

```sh
rm -f "$HOME/.claude-speak/session.json"
```

Replace it with a call into the CLI's GC, which also removes the legacy file:

```sh
# Garbage-collect stale per-session state (and the legacy 1.x session.json).
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" --cmd gc >/dev/null 2>&1 || true
```

Then add `gc` to `dispatch` in `src/subcommands.ts`:

```ts
    case 'gc':
      gcSessions();
      return { message: '', speak: false };
```

with `gcSessions` added to the existing `./session.js` import. Like `stop` and `turn-start`, `gc` stays out of `AVAILABLE_COMMANDS`.

Finally, in the `else` branch of `check-setup.sh` (the "no issues" path), replace the bare JSON echo so Claude learns voice is off:

```sh
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "## claude-speak\n\nVoice output is **off** for this session. It is off by default in every session and must be activated deliberately.\n\n- To activate: run \`/speak on\`.\n- Until then, do NOT write final messages for the ear and do NOT use the speak skill — nothing will be audible.\n- The user can silence in-flight narration at any time by typing \`!shutup\`."
  }
}
EOF
```

- [ ] **Step 4: Build and verify manually**

```bash
npm run build
```

Verify `shutup` is executable and degrades safely when the plugin root is unknown:

```bash
test -x bin/shutup && echo "executable OK"
```

Expected: `executable OK`

```bash
HOME=/nonexistent sh bin/shutup; echo "exit=$?"
```

Expected: `exit=0` (no plugin-root file, exits silently rather than erroring).

Verify the hook JSON parses and contains the new event:

```bash
node -e "const h=require('./hooks/hooks.json'); if(!h.hooks.UserPromptSubmit) throw new Error('missing UserPromptSubmit'); console.log('hooks OK')"
```

Expected: `hooks OK`

Verify `turn-start` and `gc` are silent and exit 0:

```bash
node dist/cli.js --cmd turn-start; echo "turn-start exit=$?"
node dist/cli.js --cmd gc; echo "gc exit=$?"
```

Expected: no output from either command, both `exit=0`.

Verify the setup script emits valid JSON:

```bash
CLAUDE_PLUGIN_ROOT="$PWD" OPENAI_API_KEY=x bash scripts/check-setup.sh | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s);console.log('setup JSON OK')})"
```

Expected: `setup JSON OK`

- [ ] **Step 5: Verify the full interrupt loop end to end**

This requires a restarted Claude Code session, since `hooks.json` is read at startup.

1. Restart Claude Code.
2. Run `/speak on`.
3. Ask for a response long enough to narrate for several seconds.
4. While it is speaking, type `!shutup` and press Enter. Audio must stop within a second.
5. Trigger another long narration and, while it speaks, submit any prompt. Audio must stop immediately.
6. Run `/speak status` and confirm it reports `Voice: active` and the correct session id.
7. Open a second Claude Code window in a different project. Confirm `/speak status` there reports `Voice: off` while the first window still reports `active`.

Step 7 is the regression test for the original per-session bug and must not be skipped.

- [ ] **Step 6: Commit**

```bash
git add bin/shutup hooks/hooks.json scripts/check-setup.sh src/subcommands.ts
git commit -m "feat: add shutup executable and UserPromptSubmit hook

check-setup.sh no longer wipes session state on every SessionStart, which
was silently unmuting concurrent sessions. It now runs a GC pass instead
and reports the voice-off state to the session context.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Documentation and 2.0.0 release

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `skills/speak/SKILL.md`
- Modify: `claude-speak.example.json`
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Create: `CHANGELOG.md`

**Interfaces:**
- Consumes: the final behavior of Tasks 1–8.
- Produces: no code interfaces.

- [ ] **Step 1: Update `skills/speak/SKILL.md`**

Add `on`, `off`, and the tier-1 summary guidance. In the subcommand table, replace the `mute`/`unmute` rows with:

```markdown
| `/speak on` | `--cmd on` | Activate voice for this session (required — off by default) |
| `/speak off` | `--cmd off` | Turn voice off for this session |
| `/speak mute` | `--cmd mute` | Alias for `off` |
| `/speak unmute` | `--cmd unmute` | Alias for `on` |
```

Update the routing rule keyword list to include `on` and `off`.

Add a new section after "Active Voice":

```markdown
## Voice is off by default

Voice output is inactive in every new session until the user runs `/speak on`.
The SessionStart context tells you which state you are in. While voice is off,
do not use active voice and do not shape your final messages for the ear —
nothing will be audible.

## Summarizing long messages for speech

When your final message will contain a table, a code block, or otherwise run
long, speak a short spoken version yourself using active voice as your **last
action before finishing the turn**. The visual message stays complete and
detailed; the spoken one carries only the outcome.

Do this because a table read aloud becomes a stream of label-value pairs that
is almost impossible to follow. You have the full context of the turn, so your
own two-sentence summary is better than anything the fallback can produce.

If you don't, the plugin condenses the message automatically — an LLM rewrite,
falling back to deterministic text surgery. That safety net works, but it is
guessing at what mattered. You aren't.

"As your last action" matters: speaking early in a long turn is fine for
urgency, but a summary should sit adjacent to the message it summarizes.

## Interrupting narration

The user can silence in-flight narration at any time by typing `!shutup`, and
audio also stops automatically whenever they submit a prompt. If narration
stops early, that was intentional — do not re-speak it.
```

- [ ] **Step 2: Update `CLAUDE.md`**

Replace the "Passive Voice (automatic)" section's opening claim, which currently asserts voice is enabled:

```markdown
### Voice is off by default

Voice output is **inactive** in every new session until the user runs
`/speak on`. This is deliberate: activation is a conscious per-session
decision, so no project ever starts talking unexpectedly.

The SessionStart hook tells you the current state. While voice is off, do not
use the `speak` skill and do not shape final messages for the ear.

### Passive Voice (automatic)

Once activated, your final message at the end of each turn is spoken aloud
automatically. You do not need to do anything for this to work.

If that message will contain a table, a code block, or otherwise run long,
speak a two-sentence version yourself via the `speak` skill as your last
action before finishing. Otherwise the plugin condenses it automatically,
which works but guesses at what mattered.
```

In the Subcommands list, add:

```markdown
- `on` / `off` — activate or deactivate voice for this session (off by default)
```

and note that `mute`/`unmute` are aliases.

Add to the Guidelines list:

```markdown
- The user can cut off narration with `!shutup` or by submitting a prompt. If speech stops early, that was deliberate — do not repeat it.
```

- [ ] **Step 3: Update `claude-speak.example.json`**

Add the `speech` block after `playback`:

```json
  "speech": {
    "maxChars": 500,
    "condense": true,
    "summarizer": {
      "model": "gpt-5.4-nano-2026-03-17",
      "timeout": 8,
      "maxWords": 40
    }
  },
```

- [ ] **Step 4: Update `README.md`**

Add a breaking-change section near the top, after the intro:

```markdown
## Upgrading to 2.0.0 (breaking)

**Voice output is now off by default in every session.** Run `/speak on` to
activate it. Nothing is spoken until you do.

This replaces the old global mute state, which was stored in a single file
shared by every concurrent Claude Code window and reset on every session start
— so opening a second window silently unmuted the first. Activation is now
per-session and never persists.

- `/speak on` / `/speak off` are the new canonical commands. `mute` and
  `unmute` still work as aliases.
- `~/.claude-speak/session.json` is obsolete and is deleted automatically.
- Long or table-heavy messages are now condensed before being spoken. Disable
  with `"speech": { "condense": false }`.
- Type `!shutup` to cut off narration instantly, or just submit a prompt.
```

Add `on` and `off` rows to the subcommand reference table, noting `mute`/`unmute` as aliases. Then add these two sections to the configuration reference:

```markdown
### `speech`

Controls how long or structured messages are condensed before being spoken.

| Key | Default | Meaning |
|---|---|---|
| `maxChars` | `500` | Prose longer than this (measured after markdown is stripped) gets condensed. |
| `condense` | `true` | Set `false` to speak messages verbatim, as 1.x did. |
| `summarizer.model` | `gpt-5.4-nano-2026-03-17` | Model used for the rewrite. Uses your existing OpenAI key. |
| `summarizer.timeout` | `8` | Seconds before the rewrite is abandoned for the heuristic fallback. |
| `summarizer.maxWords` | `40` | Word budget requested of the rewrite. |

Tables, code blocks, and lists of 5 or more items are always condensed
regardless of length — those are the cases that are genuinely unlistenable.

### `enabled`

A hard global kill switch. When `false`, nothing is ever spoken regardless of
session activation. It is not the on/off control for normal use — that is
`/speak on` — and most users never need to set it.

## Interrupting speech

Type `!shutup` at the Claude Code prompt to cut off narration instantly. The
`!` prefix runs it directly in your shell, so it takes effect in well under a
second rather than waiting for a model turn.

Narration also stops automatically whenever you submit a prompt, on the
assumption that if you are typing, you are done listening.

Both work even mid-synthesis: audio generated after you asked for silence is
discarded rather than played.
```

- [ ] **Step 5: Bump the version**

Set `"version": "2.0.0"` in both `package.json` and `.claude-plugin/plugin.json`.

Create `CHANGELOG.md`:

```markdown
# Changelog

## 2.0.0 — 2026-07-29

### Breaking

- **Voice output is off by default.** Every session starts silent; run
  `/speak on` to activate. Activation never persists beyond the session.
- The global `~/.claude-speak/session.json` mute file is removed. Per-session
  state now lives in `~/.claude-speak/sessions/<session_id>.json`.
- `/speak on` and `/speak off` are the canonical activation commands.
  `mute` and `unmute` remain as aliases.

### Added

- Long or table-heavy messages are condensed before speech: an LLM rewrite
  (`gpt-5.4-nano-2026-03-17` by default), falling back to deterministic text
  surgery. Configured under `speech` in `~/.claude-speak.json`.
- `!shutup` silences in-flight narration instantly, with no model turn.
- Narration also stops automatically when a prompt is submitted.

### Fixed

- Concurrent sessions no longer share mute state. Previously
  `check-setup.sh` deleted the global session file on every SessionStart,
  silently unmuting other open windows.
- Stop-hook dedup is now turn-scoped rather than time-based. This fixes both
  double-speech (active voice early in a long turn, then the Stop hook
  speaking too) and silently swallowed messages (a turn ending within the
  cooldown window of a previous active-voice call).
```

- [ ] **Step 6: Final verification**

```bash
npm test && npm run typecheck && npm run build
```

Expected: all tests pass, no type errors, `dist/cli.js` rebuilt.

Confirm no stale references to the removed API remain:

```bash
grep -rn "loadSession\|writeSession\|clearSession\|SESSION_DEFAULTS\|muted" src/ test/ skills/ CLAUDE.md README.md || echo "no stale references"
```

Expected: `no stale references`. Any hit other than the README's historical description of the old behavior is a bug to fix.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md CHANGELOG.md skills/speak/SKILL.md claude-speak.example.json package.json .claude-plugin/plugin.json
git commit -m "docs: document opt-in voice, condensation, and interrupt for 2.0.0

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

**Tasks 1–6 leave the suite red.** `session.ts` removes exports that `cli.ts` and `subcommands.ts` still import. Task 7 repairs this. Do not restore the old `loadSession` API to make an intermediate commit green — that is the thing being replaced. Run the *task-scoped* test command listed in each task, not the full suite, until Task 7.

**The stop-epoch guard appears twice**, once in `speakText` and once in the inline TTS block at the end of `run`. Both paths synthesize audio, so both need it. Resist collapsing them in this pass; that refactor is worth doing but it is not this change.

**`resolveSessionId` parses stdin independently of `extractMessage`.** That is two JSON parses of the same string. It is cheap and it keeps the modules independent — do not thread a shared parsed object through as an optimization.

**`heuristicCondense` is extractive by design.** Its tests assert cuts, not quality. If a test tempts you to make it clever, the LLM tier is where cleverness belongs.
