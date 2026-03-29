# claude-speak — Design Specification

**Date:** 2026-03-28
**Status:** Approved
**Version:** 0.1.0

---

## 1. Overview

claude-speak is a Claude Code plugin that adds voice output capabilities. It captures Claude Code's final output at the end of a turn and sends it to a text-to-speech system for local audio playback. It also gives Claude Code active awareness of its voice capability, allowing it to deliberately speak when something warrants audible attention.

The input side (voice-to-text) is out of scope. The user already handles this with Wispr Flow. This project is the "voice out" half only.

---

## 2. Core Concepts

### 2.1 Passive Voice (Hook-Triggered)

When Claude Code finishes a turn, a hook fires, extracts the last assistant message, sanitizes it for speech, sends it to a TTS provider, and plays the resulting audio locally.

The user does not need to do anything. The hook fires automatically.

### 2.2 Active Voice (Skill-Triggered)

Claude Code is made aware that it has a voice through a skill definition and behavioral instructions in CLAUDE.md. Claude can choose to speak at any point during its turn by invoking the CLI with specific text crafted for the ear.

Active voice is for moments that warrant audible attention: critical failures, blocking decisions, completed milestones, or anything the user should know about even when not watching the screen.

### 2.3 Shared Pipeline

Both trigger paths converge into the same pipeline:

```
Trigger (hook or skill) → Extractor (passive only) → Sanitizer → TTS Client → Player
```

No separate code paths. Same sanitizer, same TTS client, same player, same config, same error handling.

---

## 3. Architecture

### 3.1 Trigger A — Passive (Hooks)

Two Claude Code hooks:

- **`Stop`** — Fires when Claude's turn ends completely. Primary trigger. Extracts the last assistant message from the hook's JSON context on stdin.
- **`Notification`** — Fires when Claude needs user attention mid-work (decision points, permission requests). Same extraction logic.

Hook command format:
```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" --trigger stop
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" --trigger notification
```

### 3.2 Trigger B — Active (Skill)

Claude invokes the CLI directly with text intended for speech:
```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" --say "The deploy failed. The staging database is missing the migrations table."
```

The skill definition (`skills/voice/SKILL.md`) tells Claude what the capability is and how to invoke it. The `CLAUDE.md` at plugin root provides behavioral guidance on when to use it and when to stay quiet.

### 3.3 Active/Passive Dedup

A timestamp lockfile prevents collisions between active and passive voice. When active voice fires, it writes a timestamp to a lockfile. When a passive hook fires, it checks the lockfile. If the lock is fresher than the configured cooldown (default: 15 seconds), the hook skips its output.

Implementation: a single file on disk containing a Unix timestamp. The active voice writes it, the passive hook reads it. No daemon, no IPC.

---

## 4. Modules

### 4.1 CLI Entry Point (`src/cli.ts`)

Parses arguments, loads config, and wires the pipeline. Two modes:

- `--trigger <stop|notification>`: Passive mode. Reads JSON from stdin, runs extractor, then pipeline.
- `--say "<text>"`: Active mode. Skips extractor, feeds text directly into pipeline.

Also checks `CLAUDE_SPEAK_ENABLED` env var and exits immediately if disabled.

### 4.2 Extractor (`src/extractor.ts`)

Reads the hook's JSON context from stdin and extracts the last assistant message text. Only used in passive mode.

Returns the raw message text as a string. If extraction fails (malformed JSON, no assistant message), returns null and the pipeline aborts gracefully.

### 4.3 Sanitizer (`src/sanitizer.ts`)

Strips markdown formatting artifacts that sound unnatural when spoken. No rewriting, no summarization, no meaning alteration.

**Removed:**
- Markdown headers (`##`, `###`) — text stays, hashes removed
- Bold/italic markers (`**`, `*`, `_`)
- Code fences (triple backticks and language identifiers)
- Inline code backticks
- Link syntax `[text](url)` — keeps display text, drops URL
- Horizontal rules (`---`)
- Bullet point markers (`-`, `*`, numbered prefixes) — text stays, markers removed
- HTML tags
- Table formatting — pipe characters (`|`), alignment markers, header separator rows. Table rows are converted to natural speech: "File: app.ts, Status: updated, Notes: added error handling" using header row as labels.

**Preserved:**
- All words and sentence structure
- Punctuation (periods, commas, colons, question marks)
- Line breaks converted to natural pauses where appropriate

### 4.4 TTS Client (`src/tts/`)

Provider-agnostic interface with `gpt-4o-mini-tts-2025-12-15` as the default implementation.

**Interface (`interface.ts`):**
```typescript
interface TTSProvider {
  synthesize(text: string, options: TTSOptions): Promise<Buffer>;
}

interface TTSOptions {
  voice: string;
  model: string;
  instructions?: string;
}
```

**OpenAI implementation (`openai.ts`):**
- Calls the OpenAI TTS API with the configured voice, model, and instructions
- Returns the complete audio buffer (no streaming)
- Typical response time: 1-3 seconds for paragraph-length text

Adding a new provider means implementing the `TTSProvider` interface. No changes to the rest of the pipeline.

### 4.5 Player (`src/player.ts`)

Platform-aware audio playback:
- **macOS:** `afplay`
- **Linux:** `aplay` or `paplay`

Spawns the playback command as a detached background process. Non-blocking — the hook exits after spawning playback, it does not wait for audio to finish.

### 4.6 Config Loader (`src/config.ts`)

Merges two sources:

**Config file (`~/.claude-speak.json`):**
```json
{
  "provider": "openai",
  "model": "gpt-4o-mini-tts-2025-12-15",
  "voice": "ash",
  "instructions": "Speak in a cheeky, conversational tone. Be direct and concise.",
  "hooks": {
    "stop": true,
    "notification": true
  },
  "playback": {
    "command": "afplay"
  },
  "cooldown": 15,
  "timeout": 30,
  "logFile": "~/.claude-speak/logs/voice.log"
}
```

**Environment variables:**
- `CLAUDE_SPEAK_ENABLED` — Quick on/off toggle (default: `true` when config exists)

**Plugin `userConfig` (prompted at install):**
- `openai_api_key` — Stored in system keychain via Claude Code's plugin system. Accessed at runtime via `CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY` env var.

Precedence: env vars override config file values where they overlap. Missing config file means voice is disabled.

### 4.7 Lock Manager (`src/lock.ts`)

Manages the timestamp lockfile for active/passive dedup:
- `writeLock()`: Writes current Unix timestamp to lockfile. Called by active voice.
- `isLocked(cooldownSeconds)`: Reads lockfile, returns `true` if timestamp is within cooldown window. Called by passive hooks.

Lockfile location: `${CLAUDE_PLUGIN_DATA}/voice.lock`

### 4.8 Error Handler (`src/error.ts`)

On any failure (TTS API error, playback failure, network timeout):
1. Play a system beep (macOS: `afplay /System/Library/Sounds/Basso.aiff`, Linux: `paplay` with system alert sound)
2. Log the error to the configured log file with timestamp and context
3. Exit cleanly. Never crash the hook. Never block Claude Code.

---

## 5. Plugin Structure

```
claude-speak/
├── .claude-plugin/
│   └── plugin.json               # Plugin manifest
├── skills/
│   └── voice/
│       └── SKILL.md              # Active voice skill definition
├── hooks/
│   └── hooks.json                # Stop + Notification hook definitions
├── scripts/
│   └── install-deps.sh           # Dependency installer for SessionStart
├── src/
│   ├── cli.ts                    # Entry point: --trigger / --say
│   ├── extractor.ts              # Hook JSON stdin → assistant message
│   ├── sanitizer.ts              # Markdown/table stripping
│   ├── tts/
│   │   ├── interface.ts          # TTSProvider interface
│   │   └── openai.ts             # gpt-4o-mini-tts implementation
│   ├── player.ts                 # Platform-aware playback
│   ├── config.ts                 # Config file + env var merging
│   ├── lock.ts                   # Timestamp lockfile for dedup
│   └── error.ts                  # Beep + log handler
├── dist/                         # Compiled JS output
├── test/                         # Unit tests per module
├── package.json                  # Dependencies
├── tsconfig.json
├── settings.json                 # Default plugin settings
├── CLAUDE.md                     # Behavioral guidance for active voice
├── claude-speak.example.json     # Example user config
├── LICENSE
├── CHANGELOG.md
└── README.md
```

### 5.1 Plugin Manifest (`.claude-plugin/plugin.json`)

```json
{
  "name": "claude-speak",
  "version": "0.1.0",
  "description": "Voice output layer for Claude Code — passive spoken summaries and active voice capability",
  "author": {
    "name": "pchouinard"
  },
  "license": "MIT",
  "keywords": ["voice", "tts", "accessibility", "audio"],
  "userConfig": {
    "openai_api_key": {
      "description": "OpenAI API key for TTS (gpt-4o-mini-tts)",
      "sensitive": true
    }
  }
}
```

### 5.2 Hook Definitions (`hooks/hooks.json`)

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" --trigger stop"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" --trigger notification"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "diff -q \"${CLAUDE_PLUGIN_ROOT}/package.json\" \"${CLAUDE_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CLAUDE_PLUGIN_DATA}\" && cp \"${CLAUDE_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CLAUDE_PLUGIN_DATA}/package.json\""
          }
        ]
      }
    ]
  }
}
```

### 5.3 Dependency Management

Dependencies (OpenAI SDK, etc.) are installed to `${CLAUDE_PLUGIN_DATA}/node_modules` and persist across plugin updates. The `SessionStart` hook compares the bundled `package.json` against the stored copy and reinstalls only when they differ.

The compiled CLI in `dist/` references modules from the persistent data directory via `NODE_PATH`.

---

## 6. Configuration

### 6.1 User Config File (`~/.claude-speak.json`)

Non-secret preferences. Safe to back up, share, or version control.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | `"openai"` | TTS provider identifier |
| `model` | string | `"gpt-4o-mini-tts-2025-12-15"` | TTS model |
| `voice` | string | `"ash"` | Voice selection |
| `instructions` | string | `""` | TTS delivery instructions |
| `hooks.stop` | boolean | `true` | Enable Stop hook |
| `hooks.notification` | boolean | `true` | Enable Notification hook |
| `playback.command` | string | auto-detected | Playback command |
| `cooldown` | number | `15` | Active/passive dedup window in seconds |
| `timeout` | number | `30` | Max seconds before killing a hung TTS call |
| `logFile` | string | `"~/.claude-speak/logs/voice.log"` | Error log location |

### 6.2 Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CLAUDE_SPEAK_ENABLED` | Quick on/off toggle | `true` when config exists |
| `CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY` | API key (set by plugin system from keychain) | — |

### 6.3 Precedence

1. Environment variables (highest)
2. User config file (`~/.claude-speak.json`)
3. Built-in defaults (lowest)

---

## 7. Active Voice Behavioral Guidance

The `CLAUDE.md` at plugin root provides Claude with instructions on when and how to use the voice capability.

**When to use active voice:**
- Critical failures that need immediate attention
- Blocking decisions where Claude is waiting for user input
- Completed milestones on long-running tasks
- Security or data concerns the user should know about
- Anything the user should hear even if not looking at the screen

**When NOT to use active voice:**
- Routine status updates (the passive hook covers end-of-turn)
- Acknowledging commands ("Got it, I'll do that")
- Information that's only useful on screen (code snippets, file diffs)
- Anything the passive Stop hook will handle moments later

**Rate limiting:** The same cooldown window used for active/passive dedup (default 15 seconds, configurable via `cooldown` in config) also governs active-to-active spacing. If Claude tries to speak again within the cooldown window, the second invocation is silently skipped.

---

## 8. Error Handling

| Failure | Behavior |
|---------|----------|
| TTS API unreachable | Beep, log error, exit cleanly |
| TTS API returns error (auth, rate limit) | Beep, log error with API response, exit cleanly |
| TTS API timeout (exceeds configured timeout) | Kill request, beep, log timeout, exit cleanly |
| Audio playback fails | Log error, exit cleanly (no beep — the beep mechanism itself failed) |
| Malformed hook JSON | Log parse error, exit cleanly |
| No assistant message in hook context | Exit silently (nothing to speak) |
| Config file missing | Voice disabled, exit silently |
| Config file malformed | Beep, log parse error, exit cleanly |

In all cases: never crash the hook, never block Claude Code, never throw unhandled exceptions.

---

## 9. Testing Strategy

Each module is independently testable:

- **Extractor:** Feed it sample hook JSON, verify correct message extraction
- **Sanitizer:** Feed it markdown strings, verify clean speech-ready output. Table conversion gets dedicated test cases.
- **TTS Client:** Mock the OpenAI API, verify correct request formation and audio buffer handling
- **Player:** Mock the system command, verify correct invocation and detached execution
- **Config Loader:** Test merging logic with various combinations of config file, env vars, and defaults
- **Lock Manager:** Test write/read/expiry with controlled timestamps
- **CLI Integration:** End-to-end tests with mocked TTS that verify the full pipeline for both passive and active modes

---

## 10. Non-Goals

- Voice input (STT) — handled externally by Wispr Flow
- Continuous narration — voice fires only at meaningful moments
- Emotional or stylistic transformation at the TTS level — personality comes from Claude's text
- Web UI or dashboard — this is a CLI plugin
- Streaming audio playback — direct playback is sufficient given context
- Provider-specific features beyond the TTSProvider interface

---

## 11. Future Considerations (Post-v1)

These are explicitly out of scope for v1 but worth noting:

- Additional TTS providers (ElevenLabs, Google Cloud, local OS TTS as fallback)
- Audio caching for repeated phrases
- Streaming playback if latency becomes a concern
- Voice activity detection to pause playback when user starts speaking
- Configurable sanitization rules (user-defined strip/keep patterns)
