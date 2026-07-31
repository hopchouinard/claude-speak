# Opt-In Voice, Speech Condensation & Interrupt Design

**Date:** 2026-07-29
**Status:** Implemented (revised 2026-07-30 after whole-branch review — see §1 activation across compaction, §2 summarizer key and empty-condensation, §3 stop scoping)
**Version target:** 2.0.0 (breaking change)
**Scope:** Three features for the claude-speak plugin: (1) voice output becomes opt-in per session instead of globally on, (2) verbose or table-heavy output is condensed into speech-optimized text before TTS, (3) in-flight narration can be interrupted. Plus a correctness fix to active/passive dedup that the third feature makes possible.

---

## 0. Motivation & Current-State Findings

Three problems drive this work.

**Voice is on by default.** Once `~/.claude-speak.json` exists, `loadConfig()` returns `enabled: true` for every session in every project (`src/config.ts:138`). Opening any project produces spoken output whether or not that was wanted, and there is no per-project or per-session gate to prevent it.

**Session state is not per-session.** `~/.claude-speak/session.json` is a single global file holding one `muted` boolean. Two concurrent Claude Code windows share it. Worse, `scripts/check-setup.sh:12` deletes it on every SessionStart, so starting a second session silently unmutes the first. The existing "session mute" feature is per-machine, not per-session.

**Structured output is read aloud verbatim.** `sanitize()` flattens markdown tables into `"Header: value, Header: value"` prose (`src/sanitizer.ts:49`). A six-row summary table becomes six run-on label-value sentences. Nothing in the pipeline caps length or recognizes that a message is unlistenable.

A fourth problem surfaced during design and is fixed here because feature 3 makes the fix cheap:

**Active/passive dedup is wrong in both directions.** `lock.ts` suppresses the Stop hook when a lockfile is younger than `cooldown` seconds. If active voice fires early in a long turn, the lock goes stale and the Stop hook speaks too (double-speech). If active voice fires and the *next* turn ends inside the cooldown window, that turn's legitimate end-of-turn message is silently swallowed. Time-elapsed is a poor proxy for turn identity.

---

## 1. Feature 1 — Session-Scoped Opt-In Activation

### Decision

Voice is off unless the current session has explicitly activated it. Activation never persists beyond the session: there is no project allowlist, no remembered preference, no auto-activation. Every session that wants voice asks for it.

This was chosen over per-project stickiness deliberately. Stickiness reintroduces the exact failure being eliminated — voice turning on because of a decision made in some other session, weeks ago, that the user no longer remembers making.

### State layout

Activation is represented by the existence of a file:

```
~/.claude-speak/sessions/<session_id>.json
```

```json
{
  "active": true,
  "activatedAt": 1785000000000,
  "spokeThisTurn": false
}
```

No file means voice is off. There is no `muted` field and no inverted boolean to reason about; absence is the default state and the default state is silence.

`spokeThisTurn` belongs to feature 4 (§4) and is documented there.

### Session ID resolution

New function `resolveSessionId(hookPayload?)` in `src/session.ts`, resolving in order:

1. `session_id` from the hook stdin JSON — authoritative on the Stop, Notification, and UserPromptSubmit paths.
2. `CLAUDE_CODE_SESSION_ID` environment variable — present in the Bash tool environment (verified on Claude Code 2.1.220), which is how `--say` and `--cmd` invocations resolve.
3. Neither available → return `null`.

When resolution returns `null`, the CLI refuses to activate and reports why. There is deliberately **no** shared fallback bucket: a "default" session key would reintroduce the cross-session leakage this feature removes. A `null` session ID on the speaking paths means stay silent; on the `on` command it means report an actionable error.

### Commands

| Invocation | CLI | Effect |
|---|---|---|
| `/speak on` | `--cmd on` | Create the session file. Voice active for this session only. |
| `/speak off` | `--cmd off` | Delete the session file. |
| `/speak mute` | `--cmd mute` | Alias for `off`. |
| `/speak unmute` | `--cmd unmute` | Alias for `on`. |

`mute` and `unmute` are retained as aliases so existing muscle memory and the current `skills/speak/SKILL.md` table keep working. `on`/`off` become the canonical names because "unmute" wrongly implies a previously-audible default.

### Gating in `cli.ts`

The existing `if (session.muted) return` check at `src/cli.ts:82` becomes `if (!isActive(sessionId)) return`, in the same position — after `--cmd` routing, before `--say`/`--trigger` parsing. This preserves the current and correct property that `--cmd` remains reachable while voice is off, which is how the user turns it on.

### Session file lifecycle

- `scripts/check-setup.sh` stops deleting session state. The blanket `rm -f "$HOME/.claude-speak/session.json"` is removed; it is the direct cause of cross-session unmuting.
- SessionStart instead garbage-collects `~/.claude-speak/sessions/*.json` older than 24 hours.
- A legacy `~/.claude-speak/session.json` from 1.x is deleted by the same SessionStart GC step if present. It is not migrated: its semantics (global, default-audible) are the opposite of the new model, so carrying its value forward would produce exactly the wrong outcome.
- `--cmd gc` runs **ahead of the `enabled` kill switch** in `cli.ts`. State accumulates whether or not voice is enabled, and this is the only thing that ever collects it; gating GC on `enabled` would leave a user who set it to `false` with state that grows forever and a legacy file that is never removed.

### Activation across compaction and resume

SessionStart fires on `startup`, `compact` and `resume`. A compacted or resumed session keeps the same `session_id`, so its activation state is still valid and voice **stays active** across all three. Activation has not leaked anywhere: it is the same session, and the alternative — deactivating on compaction — would silently turn voice off mid-task for a user who never asked for that.

The consequence is that SessionStart cannot assume a silent session. See "Documentation consequences" below.

### Config reinterpretation

`config.enabled` becomes a hard global kill switch — when false, nothing speaks regardless of session state. It no longer means "voice is on"; session activation is the operative gate. Existing behavior of defaulting to `true` when a config file exists is retained, so `enabled` only matters for users who explicitly set it to `false`.

### Documentation consequences

- SessionStart `additionalContext` must state the session's **actual** voice state, not a fixed one. Without it, Claude writes final messages for the ear for output nobody will hear — or, on the compact/resume path, stops writing for the ear while the Stop hook is still speaking, which disables tier 1 of the condensation chain (§2) for the rest of the session.

  `check-setup.sh` therefore reads the SessionStart payload from stdin, resolves `session_id`, and reports one of three states:

  | State | Condition | Message |
  |---|---|---|
  | active | `~/.claude-speak/sessions/<id>.json` exists | Voice is on; write for the ear; speak your own summary before a long final message; `!shutup` interrupts. |
  | off | id resolved, no state file | Voice is off; do not write for the ear or use the speak skill; `/speak on` activates. |
  | unknown | no id resolvable (stdin empty, unparseable, or without `session_id`) | State could not be determined; run `/speak status` before assuming either way. |

  The `unknown` state is deliberate. A confident wrong claim in either direction costs more than an admitted uncertainty, and the script must emit valid JSON and exit 0 on every path regardless.

  Two implementation constraints follow: the payload must be captured before the `--cmd gc` call, which reads stdin to EOF and would otherwise consume it (gc is given `</dev/null`); and a `session_id` containing anything outside `[A-Za-z0-9._-]` is treated as unresolvable rather than interpolated into a filesystem path.
- This repository's `CLAUDE.md` opens by asserting voice output is enabled. That claim becomes conditional, describing the opt-in model instead.
- `README.md` gains a breaking-change section for 2.0.0.

### Breaking change

Existing installations go silent until `/speak on` is run. This is intentional and is the feature. Version bumps to 2.0.0 in `package.json` and `.claude-plugin/plugin.json`, with a CHANGELOG entry.

No escape-hatch config for always-on behavior is provided. Such a setting would recreate the footgun — a persistent global toggle that speaks in projects the user forgot they enabled.

---

## 2. Feature 2 — Speech Condensation

### Decision

A four-tier fallback chain, ordered by output quality:

```
1. Claude authors its own spoken summary (active voice; hook suppressed)
2. LLM rewrite of the final message
3. Deterministic heuristic condensation
4. (never) the raw wall of table-prose
```

Tier 1 is the highest quality because Claude has full turn context and knows what actually mattered. Tier 2 exists because tier 1 depends on Claude remembering. Tier 3 exists because tier 2 depends on a network call. Tier 4 is the current behavior and is what this feature exists to prevent.

### Tier 1 — Claude authors the summary

No new code. The active-voice path plus turn-scoped dedup (§4) already produces exactly this behavior: Claude speaks a short version, the Stop hook stays quiet.

What changes is guidance, added to `skills/speak/SKILL.md` and this project's `CLAUDE.md`:

> When your final message will contain a table, a code block, or otherwise run long, speak a two-sentence spoken version via active voice as your last action before finishing the turn. The visual message stays complete and detailed; the spoken one carries only the outcome.

"As your last action" matters: it keeps the spoken summary adjacent to the message it summarizes.

### Pipeline placement

Detection requires raw markdown. `sanitize()` destroys tables and code fences, which are the strongest signals that a message is unlistenable. Condensation therefore runs **before** the sanitizer, not as part of it:

```
extractMessage(stdin)
  → shouldCondense(raw)?
      → summarizeForSpeech(raw)  ?? heuristicCondense(raw)
  → sanitize(text)
  → synthesize → play
```

The existing sanitizer is unchanged and still runs on the condensed output, since an LLM rewrite can still emit stray markdown.

Condensation applies to the **passive path only** — `--trigger stop` and `--trigger notification`. It never touches `--say`. Active-voice text is hand-written by Claude for the ear; rewriting it would degrade the highest-quality tier in the chain and could summarize a message that is already two sentences long.

### `src/condenser.ts` — pure, no I/O

```ts
shouldCondense(raw: string, maxChars: number): boolean
heuristicCondense(raw: string, maxChars: number): string
```

`shouldCondense` returns true when **any** of the following holds:

- the text contains a markdown table (a pipe row followed by a `|---|` separator row — reuse the detection already present in `sanitizer.ts:58`)
- the text contains a fenced code block
- the text contains 5 or more list items (bullet or numbered)
- the sanitized text exceeds `maxChars` (default **500**)

Structured content always triggers regardless of length, because a three-line message containing a table is the core problem case. Plain prose gets the 500-character allowance.

`heuristicCondense` is the deterministic floor:

- drop table blocks and fenced code blocks entirely, including contents
- keep the first 3 list items, replacing the remainder with `"and N more"`
- keep the first and last paragraph, dropping the middle
- truncate to `maxChars` on a sentence boundary, never mid-word

### `src/summarizer.ts` — I/O

```ts
summarizeForSpeech(raw: string, config: VoiceConfig): Promise<string | null>
```

- Provider: OpenAI, via raw `fetch` to the chat completions endpoint. No new dependencies.
- Model default: `gpt-5.4-nano-2026-03-17`, read from config rather than hardcoded.
- API key: reuses `config.apiKeys.openai`. No new credential is introduced.

  Consequence: this tier requires an **OpenAI** key specifically, whatever the active TTS provider is. An ElevenLabs-only user — a fully supported configuration — never reaches tier 2 and always lands on tier 3. That is acceptable (tier 3 is deterministic and offline) but it must be documented in the README rather than discovered, and it is what makes the empty-condensation case below routinely reachable rather than exotic.
- Timeout: `AbortController`, default 8 seconds.
- Returns `null` on **any** failure — missing key, non-200, timeout, malformed response, empty content. Never throws to the caller.

System prompt:

> Rewrite this message to be heard, not read. Two sentences maximum, under 40 words. State the outcome and the single number that matters most. No markdown, no file paths, no lists. If the input was a table of results, say how many there were and whether they passed.

When `summarizeForSpeech` returns `null`, the caller falls back to `heuristicCondense` and logs the failure reason to `config.logFile`. Speech is never blocked by summarizer failure.

### When the heuristic condenses to nothing

`heuristicCondense` is extractive: it can only cut. A message that is *only* a table, or *only* a fenced code block, therefore strips to the empty string — and tier 4 of the chain must never be silence, which is what an empty string produces. 1.x read something aloud for those messages; going quiet reads as a broken plugin, and it emits a WARN line every turn on top.

So an empty heuristic result is replaced with one short fixed line saying the message does not read aloud well and the detail is on screen. Fixed rather than generated: there is nothing left to summarize by that point, and a second network call to describe a message we already failed to condense is not worth the latency.

### Config addition

```json
"speech": {
  "maxChars": 500,
  "condense": true,
  "summarizer": {
    "model": "gpt-5.4-nano-2026-03-17",
    "timeout": 8,
    "maxWords": 40
  }
}
```

`condense: false` disables tiers 2 and 3, restoring 1.x verbatim behavior for users who want it. Defaults are supplied by `getSharedDefaults()` following the existing pattern in `config.ts:58`.

### Latency

The Stop hook already begins with `sleep 2` (`hooks/hooks.json:8`). The summarizer adds roughly 0.5–1.5 seconds before synthesis begins. Acceptable for end-of-turn speech; the 8-second timeout bounds the worst case.

---

## 3. Feature 3 — Interrupt

### Decision

Two triggers, both chosen for latency:

- **Auto-stop on prompt submit** — a `UserPromptSubmit` hook kills in-flight audio the moment a message is sent. If the user is typing, they are done listening.
- **`!shutup`** — an executable in the plugin's `bin/` directory, already on `PATH`. Typed at the Claude Code prompt with the `!` bash prefix, it runs immediately in the shell with no model turn, giving sub-second kill latency.

A `/speak stop` slash command was considered and rejected: reaching the CLI through a model turn means 3–6 seconds of continued narration, which fails the one requirement a panic button has. `--cmd stop` still exists as an internal entry point, but it is not advertised as a user-facing slash command. Kill logic lives in exactly one function, `stopPlayback()` in `player.ts`, which both the `stop` and `turn-start` subcommands call.

Both triggers must work **regardless of session activation state**. They route through `--cmd`, which by design remains reachable while voice is off (`cli.ts:62`), and playback state is machine-global — so `!shutup` silences audio started by a different session than the one running it.

A global hotkey daemon was rejected as disproportionate: a resident process and macOS Accessibility permissions to solve a problem the two triggers above already solve.

### State layout

Playback state is **machine-global**, not per-session:

```
~/.claude-speak/playback.json   →  { "pid": 12345, "startedAt": 1785…, "sessionId": "…" }
~/.claude-speak/stop-epoch      →  { "epoch": 1785000000000, "sessionId": "…" | null }
```

Rationale: there is one audio device. The user hearing unwanted narration cannot tell which window produced it, and `!shutup` must kill whatever is playing regardless of origin.

**The kill is global; the discard is not.** These are two different operations and they need different scopes:

- **SIGTERM of the audible stream** is always machine-wide. Silencing what is coming out of the speakers is exactly what the user asked for.
- **Discarding audio that has not started playing yet** is scoped to the session that stamped the stop. That audio belongs to some other window's pipeline, which will drop the message and never retry it — the user of that window asked for nothing.

`stop-epoch` therefore records the session that stamped it, and `readStopEpoch(sessionId)` reports `0` for a stop belonging to a different session. `sessionId: null` means an unattributed, deliberately global stop.

| Trigger | Stamped as | Kills audible audio | Discards pending audio |
|---|---|---|---|
| `!shutup` (`--cmd stop`) | `sessionId: null` | machine-wide | every session — it is a panic button |
| `UserPromptSubmit` (`--cmd turn-start`) | the submitting session | machine-wide | that session only |

A bare-number `stop-epoch` (the pre-2.0.0 format) is read as a global stop.

This gives the boundary: **the audio device is machine-global; the decision to throw away a message is per-session, as are activation and turn state.**

### `src/player.ts` changes

- Before `spawn`, SIGTERM any stream already tracked in `playback.json` and clear it. One audio device, one stream: spawning over a live stream would overwrite its PID and leave it unaddressable, so `!shutup` could only ever silence the newest one. This kill stamps **no** epoch, so it cannot discard anyone's pending audio.
- After `spawn`, write `playback.json` with the child PID and the owning session id.
- On child exit, delete `playback.json` in addition to the existing temp-file cleanup.
- `child.unref()` is retained; the PID file is what makes the detached process addressable.

### `stopPlayback(scopeSessionId)`

1. Write `stop-epoch = { epoch: Date.now(), sessionId: scopeSessionId }`.
2. Read `playback.json`; if absent, done.
3. `process.kill(pid, 'SIGTERM')`, swallowing `ESRCH` (process already exited).
4. Delete `playback.json`.

Order matters: the epoch is stamped **first**, so a stop racing against a synthesis that is about to finish still registers.

### The synthesis race

Synthesis takes 1–2 seconds. A stop request arriving in that window kills a PID that does not yet exist, and audio begins *after* the user demanded silence. This is the failure mode that makes a naive PID-kill implementation feel broken.

Fix: `cli.ts` captures `requestedAt = Date.now()`. After synthesis returns, it reads the stop epoch **for its own session**; if `stopEpoch > requestedAt`, the audio buffer is discarded and never played. Deterministic, cheap, and closes the window completely.

This check applies to both the passive and active voice paths, and the two stamp positions differ deliberately:

- `run()` (passive) stamps **before condensation**. The summarizer can block for seconds, and that window is widest exactly when the network is degraded — which is when the user is most likely to give up and hit stop.
- `speakText()` (`--say`, subcommand confirmations) stamps **immediately before synthesis**. There is no condensation step on that path to cover.

The guard is duplicated rather than extracted for this reason. Any future extraction must preserve both stamp positions, or one path loses part of its stop window; both call sites carry a comment saying so, and both are covered by tests.

### `bin/shutup`

```sh
#!/bin/sh
ROOT="$(cat "$HOME/.claude-speak/plugin-root" 2>/dev/null)"
[ -n "$ROOT" ] || exit 0
exec node "$ROOT/dist/cli.js" --cmd stop
```

`~/.claude-speak/plugin-root` is already written by the SessionStart hook (`hooks/hooks.json:28`), so no new resolution mechanism is needed. The file must be committed with the executable bit set. Claude Code already places plugin `bin/` directories on `PATH`, so `!shutup` works with no user setup.

The name `shutup` was chosen for absence of collision with system terminology.

### `UserPromptSubmit` hook

```json
"UserPromptSubmit": [
  { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" --cmd turn-start" }] }
]
```

`turn-start` is a distinct subcommand rather than `stop` plus a flag, because it does two things: call `stopPlayback()` (this feature) and reset the turn flag (§4). `shutup` calls `stop`, which does only the first.

Hard constraints: no `sleep`, always exits 0, never blocks prompt submission.

**Within one session** there is no false-suppression risk: the stop epoch this hook stamps is always older than the `requestedAt` of the Stop hook it precedes, so it cannot discard the audio of the turn it begins.

That argument does **not** extend across sessions, and an earlier draft of this document wrongly implied it did. The epoch is machine-global state: window B submitting a prompt stamps an epoch newer than the `requestedAt` of a pipeline already in flight in window A. Window A's end-of-turn message would then fail its stop check and be discarded — never spoken, never retried — with an exposure of roughly ten seconds per narration (a 2s Stop-hook sleep plus up to 8s of condensation). Anyone running two Claude Code windows hits this routinely.

This is why `turn-start` stamps a **session-scoped** stop (see "State layout" above) while `!shutup` stamps a global one. Prompt submission is an incidental byproduct of typing in one window; `!shutup` is a deliberate demand for machine-wide silence.

---

## 4. Feature 4 — Turn-Scoped Dedup (Correctness Fix)

### The problem

`lock.ts` uses elapsed time as a proxy for turn identity, and fails in both directions:

- Active voice at t=0, turn ends at t=90s → lock is stale → Stop hook also speaks. **Double-speech.**
- Active voice in turn N, turn N+1 ends 12 seconds later → lock still inside the 15s cooldown → turn N+1's end-of-turn message is discarded. **Silent swallow.**

### The fix

`UserPromptSubmit` fires exactly once at the start of every turn, providing a real turn boundary. Since that hook is being added for feature 3 anyway, exact dedup becomes nearly free.

`spokeThisTurn` in the per-session file is the mechanism:

| Event | Action |
|---|---|
| `UserPromptSubmit` (`--cmd turn-start`) | set `spokeThisTurn = false` |
| `--say` (active voice) | set `spokeThisTurn = true` |
| `--trigger stop` | if `true`, suppress speech; **always** reset to `false` |

The Stop hook resetting the flag unconditionally, whether or not it suppressed, is deliberate. If `UserPromptSubmit` ever fails to fire — older Claude Code, disabled hook, unforeseen harness change — the worst outcome is one suppressed message rather than permanent silence. The mechanism self-heals.

### What happens to `cooldown`

`cooldown` and `lock.ts` are retained with their scope narrowed to notification triggers only:

- **Kept:** suppressing `--trigger notification` speech shortly after active voice. Notifications are not turn-scoped — several can fire within a single turn — so an elapsed-time rate limiter is the right mechanism there, and `spokeThisTurn` is not.
- **Removed:** deciding whether `--trigger stop` should speak. That moves to `spokeThisTurn`, which is exact.

Note on current behavior: the `--say` path calls `writeLock()` but never `isLocked()`, so consecutive active-voice calls are not rate-limited today. That remains true after this change. Adding such a limit is out of scope — no observed problem motivates it, and Claude issuing several active-voice calls in one turn is already discouraged by the skill guidance.

`lock.ts` itself is unmodified; only its caller's use of it narrows.

### Known limitation

A subagent's Bash environment may carry the parent session ID. A subagent using active voice would therefore set `spokeThisTurn` on the parent session and suppress the parent's end-of-turn message. This is accepted as reasonable behavior — the user did hear something spoken during that turn — and is not worked around.

---

## 5. Module Summary

| Module | Change |
|---|---|
| `src/session.ts` | Rewritten. Per-session-ID state, default-off, `resolveSessionId()`, `isActive()`, `setActive()`, turn-flag accessors, GC of stale files. |
| `src/condenser.ts` | **New.** `shouldCondense()`, `heuristicCondense()`. Pure, no I/O. |
| `src/summarizer.ts` | **New.** `summarizeForSpeech()` via `fetch`. Returns `null` on any failure. |
| `src/player.ts` | PID file write/clear (with owning session), single-stream enforcement in `playAudio()`, `stopPlayback(scopeSessionId)`, session-scoped stop-epoch read/write, `readPlaybackState()`. |
| `src/cli.ts` | Activation gate replaces mute gate; condensation step on the passive path; `requestedAt`/stop-epoch race check, scoped to the session; `gc` runs ahead of the `enabled` kill switch. |
| `src/subcommands.ts` | `on`, `off`, `stop`, `turn-start`, `gc` handlers; `mute`/`unmute` aliases; `status` reports session activation and playback state. |
| `src/config.ts` | `speech` config block with defaults; `enabled` reinterpreted as hard kill switch. |
| `src/lock.ts` | Unchanged code, narrowed role (active-voice rate limiting only). |
| `bin/shutup` | **New.** Executable shell wrapper. |
| `hooks/hooks.json` | Add `UserPromptSubmit`. |
| `scripts/check-setup.sh` | Remove session wipe; add stale-session GC (fed `</dev/null` so it cannot eat the payload); report the session's real voice state — active / off / unknown — in `additionalContext`. |
| `CLAUDE.md`, `README.md`, `skills/speak/SKILL.md` | Opt-in model, `!shutup`, tier-1 summary guidance, breaking-change notes. |
| `claude-speak.example.json` | Add `speech` block. |

---

## 6. Error Handling

Every failure degrades rather than blocking.

| Condition | Behavior |
|---|---|
| Session ID unresolvable, speaking path | Stay silent. Debug-log the reason. |
| Session ID unresolvable, `--cmd on` | Actionable error message. No activation, no global fallback. |
| Summarizer key missing / non-200 / timeout / malformed | Return `null`, fall back to `heuristicCondense`, log to `logFile`. |
| `process.kill` on a dead PID | Swallow `ESRCH`. |
| Corrupt session or playback JSON | Delete the file, treat as absent. Matches existing `session.ts:34` behavior. |
| Session state write fails (EACCES, ENOSPC) | Swallow. Activation state is best-effort; every read path already treats a missing file as "voice off", and throwing would crash the calling hook. |
| Heuristic condenses to the empty string | Speak the fixed fallback line (§2). Never fall through to silence. |
| Missing `plugin-root` file in `bin/shutup` | Exit 0 silently. |
| `UserPromptSubmit` hook error | Always exit 0. Never block prompt submission. |
| Stop request during synthesis, same session | Discard the audio buffer. Never play. |
| Stop request during synthesis, different session | Play. The kill was global; the discard is not (§3). |
| SessionStart payload absent or unparseable | Report voice state as `unknown` and say so. Still emit valid JSON, still exit 0. |

---

## 7. Testing

New test files:

- **`test/condenser.test.ts`** — table detection, code-fence detection, the 5-item list boundary, the 500-char boundary; heuristic output drops tables and code, truncates on sentence boundaries and never mid-word, emits `"and N more"` for long lists.
- **`test/summarizer.test.ts`** — mocked `fetch`: success returns text; non-200, timeout via `AbortController`, malformed JSON, and empty content each return `null`. Verifies the request carries the configured model.

Rewritten:

- **`test/session.test.ts`** — default is off with no file present; two session IDs do not interfere; `resolveSessionId` precedence (stdin over env, `null` when neither); GC removes files older than 24h and preserves fresh ones; corrupt file is deleted and treated as absent; legacy `session.json` is removed rather than migrated.
- **`test/player.test.ts`** — PID file written on spawn (with its owning session) and cleared on exit; a live stream is killed before a new one spawns, and that kill stamps no epoch; `stopPlayback` sends SIGTERM and stamps the epoch; stop-epoch is written before the kill; dead PID does not throw; a stop stamped by another session is invisible to this one, while an unattributed or legacy bare-number stop is global; `readPlaybackState` reports pid, start time and owner.

Extended:

- **`test/cli.test.ts`** — an inactive session produces no speech on any trigger; `--cmd on` and `--cmd stop` both succeed while inactive; condensation runs for passive input over threshold, is skipped under it, and never runs on `--say`; an empty heuristic result speaks the fallback rather than nothing; audio synthesized before a stop request is discarded **on both the passive path and the `speakText` path** — the latter pins a guard that would otherwise be deletable with the suite still green; the stop check and `playAudio` both carry the session id; `gc` runs with `enabled: false`.
- **`test/subcommands.test.ts`** — `on`/`off`/`stop`/`turn-start`/`gc`; `mute`/`unmute` alias equivalence; `stop` stamps a global stop and `turn-start` a session-scoped one; `status` output includes activation and playback state.

`test/lock.test.ts` needs no changes. `lock.ts` code is untouched; only its caller's use of it narrows.

The dedup fix (§4) is covered by a table-driven test over the three transitions: turn-start clears, `--say` sets, Stop consumes-and-clears — including the case where Stop runs twice with no intervening turn-start, which must speak the second time.
