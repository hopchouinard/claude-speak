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
- API keys stored in `~/.claude-speak/env` are now read by the CLI itself, so
  they reach every invocation path. The hooks sourced that file before running
  the CLI but the speak skill did not, so a key kept only there worked for
  end-of-turn speech and failed for active voice and every speaking subcommand
  — silently, apart from an error beep. This was most visible in 2.0.0 because
  a long message is now summarized through active voice, so exactly the
  messages condensation exists for produced no sound at all.
