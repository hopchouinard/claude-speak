# claude-speak

Voice output layer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Converts Claude's text responses into natural speech and plays them through your local speakers, so you can work hands-free.

This is **not** a voice input system and it is **not** the built-in Claude Code voice mode. It is a dedicated text-to-speech plugin that gives Claude the ability to speak its responses aloud, either automatically at the end of every turn or deliberately when something warrants your audible attention.

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

## Table of Contents

- [Upgrading to 2.0.0](#upgrading-to-200-breaking)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Post-Installation Setup](#post-installation-setup)
- [Configuration Reference](#configuration-reference)
- [Interrupting speech](#interrupting-speech)
- [How It Works](#how-it-works)
- [Session Controls](#session-controls)
- [Multi-Provider Support](#multi-provider-support)
- [Deduplication and Cooldown](#deduplication-and-cooldown)
- [Quick Toggle](#quick-toggle)
- [Debugging](#debugging)
- [Architecture](#architecture)
- [Platform Support](#platform-support)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Features

- **Passive voice** -- Automatically speaks Claude's final message at the end of each turn via hooks
- **Active voice** -- Claude can choose to speak mid-turn when something warrants your immediate audible attention (build failures, blocking questions, completed milestones)
- **Opt-in per session** -- Voice output is off by default in every new session; `/speak on` activates it for that session only
- **Multi-provider TTS** -- Supports both OpenAI (`gpt-4o-mini-tts`) and ElevenLabs, with full configuration for each provider stored side by side
- **Subcommand system** -- Control provider, voice, speed, activation, and more via `/speak` subcommands without leaving your session
- **Smart deduplication** -- Turn-scoped tracking stops the passive Stop hook from repeating a message active voice already spoke this turn; a separate cooldown covers Notification events
- **Speech condensation** -- Long or table-heavy messages are rewritten into a short spoken summary (LLM rewrite, falling back to a deterministic heuristic) before being sent to TTS
- **Instant interrupt** -- `!shutup` cuts off in-flight narration immediately, and submitting a prompt stops it automatically
- **Markdown sanitization** -- Strips headers, bold/italic, code fences, tables, links, and HTML before sending text to TTS, so speech sounds natural
- **Table-to-speech conversion** -- Markdown tables are converted to "Header: Value" pairs for intelligible spoken output
- **Voice cache** -- ElevenLabs voices are cached locally for fast name-to-ID resolution without repeated API calls
- **Auto-migration** -- Upgrades from the old flat config format to the new nested format automatically

## Prerequisites

Before installing claude-speak, make sure you have the following:

### 1. Claude Code CLI

You need Claude Code installed and working. claude-speak is a Claude Code plugin and cannot run standalone.

```bash
# Install Claude Code if you haven't already
npm install -g @anthropic-ai/claude-code
```

### 2. Node.js 18+

The plugin requires Node.js 18 or later (20+ recommended). Check your version:

```bash
node --version
```

### 3. TTS API Key

claude-speak supports two TTS providers. You need at least one API key:

| Provider | API Key | Get it at |
|----------|---------|-----------|
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| ElevenLabs | `ELEVENLABS_API_KEY` | https://elevenlabs.io/app/settings/api-keys |

### 4. Audio Playback

Your system needs a command-line audio player:

| Platform | Required Player | Notes |
|----------|----------------|-------|
| macOS | `afplay` | Built-in, nothing to install |
| Linux | `paplay` or `aplay` | Install via `pulseaudio-utils` or `alsa-utils` |

The plugin auto-detects the correct player for your platform.

## Installation

Install from the Claude Code plugin marketplace:

```bash
claude plugin install claude-speak
```

During installation, you will be prompted for your OpenAI API key. This key is stored securely in your system keychain via the Claude Code plugin system.

## Post-Installation Setup

After installation, two additional steps are required before voice output will work.

### Step 1: Create the Configuration File

Copy the example configuration to your home directory:

```bash
cp "$(cat ~/.claude-speak/plugin-root)/claude-speak.example.json" ~/.claude-speak.json
```

Then edit `~/.claude-speak.json` to customize your preferences. See the [Configuration Reference](#configuration-reference) below for all options.

### Step 2: Configure API Keys

API keys are configured during plugin installation. Claude Code prompts you for your OpenAI and/or ElevenLabs API keys and stores them securely in your system keychain. Keys are never written to disk or exposed in conversation context.

If you need to reconfigure your keys, reinstall the plugin:

```bash
claude plugin install claude-speak
```

> **Alternative:** If you prefer, you can set `OPENAI_API_KEY` and/or `ELEVENLABS_API_KEY` in your shell profile (`.zshrc`, `.bashrc`, etc.) instead of using the keychain. The plugin checks both sources.

### Step 3: Restart Claude Code

After completing the setup, restart your Claude Code session. On the next `SessionStart`, the plugin will verify your configuration and hooks will begin firing automatically.

> **Setup verification:** If something is misconfigured, the plugin's `SessionStart` hook will display setup instructions at the top of your session telling you exactly what's missing.

## Configuration Reference

The configuration file lives at `~/.claude-speak.json`. It uses a nested provider format where each TTS provider has its own configuration block.

```json
{
  "activeProvider": "openai",
  "providers": {
    "openai": {
      "model": "gpt-4o-mini-tts-2025-12-15",
      "voice": "Marin",
      "instructions": "Speak in a cheeky, conversational tone. Be direct and concise.",
      "speed": 1.0
    },
    "elevenlabs": {
      "model": "eleven_multilingual_v2",
      "voice": "Rachel",
      "voiceId": "21m00Tcm4TlvDq8ikWAM",
      "stability": 0.5,
      "similarityBoost": 0.75,
      "style": 0.0,
      "speed": 1.0
    }
  },
  "hooks": {
    "stop": true,
    "notification": true
  },
  "playback": {
    "command": "afplay"
  },
  "speech": {
    "maxChars": 500,
    "condense": true,
    "summarizer": {
      "model": "gpt-5.4-nano-2026-03-17",
      "timeout": 8,
      "maxWords": 40
    }
  },
  "cooldown": 15,
  "timeout": 30,
  "logFile": "~/.claude-speak/logs/voice.log"
}
```

> **Upgrading from v1.0.x:** If you have an old flat config, the plugin auto-migrates it to the nested format on first load. Your existing settings are preserved under `providers.openai`.

### Shared Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `activeProvider` | `string` | `"openai"` | Which provider to use. `"openai"` or `"elevenlabs"`. |
| `hooks.stop` | `boolean` | `true` | Enable the Stop hook (speaks Claude's final message at end of turn). |
| `hooks.notification` | `boolean` | `true` | Enable the Notification hook (speaks when Claude sends a notification). |
| `playback.command` | `string` | Auto-detected | Audio playback command. Auto-detects `afplay` on macOS or `paplay` on Linux. |
| `cooldown` | `number` | `15` | Seconds after an active voice event during which the passive hook will not fire. |
| `timeout` | `number` | `30` | Maximum seconds to wait for the TTS API before giving up. |
| `logFile` | `string` | `"~/.claude-speak/logs/voice.log"` | Path to the error log file. Supports `~/` expansion. |

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

**The summarizer needs an OpenAI key, whichever TTS provider you use.** The
rewrite tier calls the OpenAI chat completions API directly, so it is skipped
unless `OPENAI_API_KEY` (or the keychain-stored plugin option) is set. If you
run ElevenLabs for speech and have no OpenAI key, everything still works —
condensation just drops straight to the deterministic heuristic, which cuts
tables, code blocks and long lists rather than rewriting them. Set both keys
if you want the better summaries; only `ELEVENLABS_API_KEY` is required to
hear anything at all.

If condensation strips a message down to nothing — a message that was *only* a
table, or *only* a fenced code block — a short fixed line is spoken instead of
silence, pointing you at the screen for the detail.

### `enabled`

A hard global kill switch, set via the `CLAUDE_SPEAK_ENABLED` environment
variable (see [Quick Toggle](#quick-toggle)) rather than a key in
`~/.claude-speak.json`. When set to `false`, nothing is ever spoken regardless
of session activation. It is not the on/off control for normal use — that is
`/speak on` — and most users never need to touch it.

### OpenAI Provider Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | `string` | `"gpt-4o-mini-tts-2025-12-15"` | OpenAI TTS model. |
| `voice` | `string` | `"ash"` | Voice name. Options: alloy, ash, ballad, cedar, coral, echo, fable, marin, nova, onyx, sage, shimmer, verse. |
| `instructions` | `string` | `""` | Delivery instructions controlling tone, pacing, and personality. |
| `speed` | `number` | `1.0` | Speech speed. Range: 0.25 (slow) to 4.0 (fast). |

### ElevenLabs Provider Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | `string` | `"eleven_multilingual_v2"` | ElevenLabs TTS model. |
| `voice` | `string` | `""` | Voice name (resolved via local cache). |
| `voiceId` | `string` | `""` | Voice ID (UUID). Takes precedence over `voice` name. |
| `speed` | `number` | `1.0` | Speech speed. Range: 0.25 to 4.0. |
| `stability` | `number` | `0.5` | Voice consistency vs. expressiveness (0.0-1.0). |
| `similarityBoost` | `number` | `0.75` | How closely to match the original voice (0.0-1.0). |
| `style` | `number` | `0.0` | Style exaggeration (0.0-1.0). |

### Voice Instructions Tips

The `instructions` field (OpenAI only) controls how the TTS model delivers your text. Some ideas:

```json
"instructions": "Speak in a cheeky, conversational tone. Be direct and concise."
```

```json
"instructions": "Calm and professional. Pause briefly between sentences. Enunciate technical terms clearly."
```

```json
"instructions": "Energetic and enthusiastic. Speed up slightly for lists, slow down for important points."
```

## Interrupting speech

Type `!shutup` at the Claude Code prompt to cut off narration instantly. The
`!` prefix runs it directly in your shell, so it takes effect in well under a
second rather than waiting for a model turn.

Narration also stops automatically whenever you submit a prompt, on the
assumption that if you are typing, you are done listening.

Both work even mid-synthesis: audio generated after you asked for silence is
discarded rather than played.

## How It Works

claude-speak operates in two modes that work together:

### Passive Voice (Automatic)

When Claude finishes a turn, the plugin's `Stop` hook fires automatically — but only if voice was activated for this session with `/speak on`:

1. Claude Code invokes the `Stop` hook, passing the session context as JSON on stdin
2. The CLI checks whether this session is active; if not, it exits silently
3. If active voice already spoke this turn, the hook exits silently rather than repeating it (see [Deduplication and Cooldown](#deduplication-and-cooldown))
4. API keys are loaded from the system keychain (or environment variables)
5. The CLI extracts the `last_assistant_message` from the JSON
6. The sanitizer strips all markdown formatting into clean natural text
7. If the result is long, tabular, or code-heavy, it is condensed first (see [`speech`](#speech))
8. The sanitized text is sent to the active TTS provider's API
9. The resulting audio is written to a temp file and played via `afplay`/`paplay`
10. The playback process is detached so the CLI exits immediately without blocking Claude Code

There is a built-in 2-second delay before the Stop hook fires, giving you time to start reading the response before audio begins.

### Active Voice (Deliberate)

Claude has a bundled skill called `speak` that lets it deliberately speak during a turn. Claude will use this for:

- **Critical failures** -- a build broke, a deploy failed, a test suite collapsed
- **Blocking decisions** -- Claude needs your input before continuing
- **Completed milestones** -- a long-running task finished successfully
- **Security or data concerns** -- something you must know about immediately
- **You're not watching** -- anything important enough that it shouldn't wait for you to glance at the screen
- **A final message that's long or table-heavy** -- Claude speaks a short spoken summary as its last action before finishing the turn, rather than letting the automatic condenser guess

When active voice fires, the CLI marks the turn as already spoken before synthesis even starts. This prevents the end-of-turn passive hook from repeating the same information later in the same turn.

## Session Controls

claude-speak provides subcommands you can invoke during a session via `/speak` in Claude Code:

| Command | Effect |
|---------|--------|
| `/speak on` | Activate voice output for this session (required — off by default) |
| `/speak off` | Deactivate voice output for this session |
| `/speak mute` | Alias for `/speak off` |
| `/speak unmute` | Alias for `/speak on` (speaks a confirmation to prove it works) |
| `/speak provider openai` | Switch to OpenAI TTS (persistent) |
| `/speak provider elevenlabs` | Switch to ElevenLabs TTS (persistent) |
| `/speak voice Marin` | Change the speaking voice (persistent) |
| `/speak voices` | List available voices for the current provider |
| `/speak speed 1.2` | Adjust speech speed, 0.25-4.0 (persistent) |
| `/speak status` | Show current provider, voice, speed, activation state |
| `/speak test` | Speak a diagnostic phrase to verify everything works |

**Session vs. persistent changes:**
- **Activation (`on`/`off`, `mute`/`unmute`)** is session-only. Every new session starts off — voice is inactive until you run `/speak on`.
- **Provider, voice, and speed** changes write to `~/.claude-speak.json` and persist across sessions.

## Multi-Provider Support

claude-speak supports both OpenAI and ElevenLabs TTS providers. Both can be fully configured in your config file simultaneously; you switch between them with `/speak provider`.

### Setting Up ElevenLabs

1. Ensure your ElevenLabs API key is configured. If you didn't set it during plugin installation, reinstall the plugin (`claude plugin install claude-speak`) or set `ELEVENLABS_API_KEY` in your shell profile.

2. Switch to ElevenLabs:
   ```
   /speak provider elevenlabs
   ```

3. Fetch your available voices (pulls from your ElevenLabs account):
   ```
   /speak voices
   ```

4. Select a voice:
   ```
   /speak voice Rachel
   ```

### Voice Management

ElevenLabs voices are identified by UUIDs internally, but the plugin lets you select voices by name. Behind the scenes, `/speak voices` fetches the voices in your ElevenLabs account and caches them locally at `~/.claude-speak/voices-elevenlabs.json`. This cache is used for name-to-ID resolution.

**Name matching** is flexible. The plugin tries, in order:

1. **Exact match** -- `Rachel` matches `Rachel`
2. **Prefix match** -- `Nina` matches `Nina - nerdy`
3. **Substring match** -- `nerdy` matches `Nina - nerdy`

**Multi-word names** are supported. If a voice has a descriptive name like `Nina - nerdy` or `Sarah - Mature, Reassuring`, you can type the full name:

```
/speak voice Nina - nerdy
```

**Ambiguous matches** are handled safely. If your search term matches multiple voices (e.g., `Sarah` matches both `Sarah - Mature` and `Sarah - Soft`), the plugin shows all candidates and asks you to be more specific rather than silently picking one.

**Refreshing the cache:** Run `/speak voices` again after adding new voices to your ElevenLabs account.

**Raw voice IDs** also work. If a name can't be resolved from the cache, the plugin treats the input as a raw voice ID. So you can always paste a UUID directly if needed.

### OpenAI Voices

OpenAI voices are a fixed set and don't require caching. The available voices are: alloy, ash, ballad, cedar, coral, echo, fable, marin, nova, onyx, sage, shimmer, verse.

## Deduplication and Cooldown

Two different mechanisms prevent double-speaking, depending on which hook is involved:

**Stop hook (end of turn):** Each session tracks an exact, turn-scoped "spoke this turn" flag rather than a timestamp.

1. When active voice fires (`--say`), the flag is set immediately, before synthesis even starts
2. When the passive Stop hook fires, it checks and clears the flag
3. If the flag was set, the Stop hook exits silently instead of repeating the message
4. Submitting a new prompt resets the flag for the next turn

This is exact rather than time-based: it does not matter whether active voice spoke 1 second or 30 seconds before the Stop hook fires, and a turn ending just after a previous cooldown-based check would no longer be silently swallowed the way a shared timer could cause.

**Notification hook:** Notifications aren't tied to a single turn the way Stop is, so they still use a timestamp lock at `~/.claude-speak/voice.lock` and the `cooldown` config value (default: 15 seconds). If a notification fires within `cooldown` seconds of the last spoken event, it's skipped.

## Quick Toggle

Temporarily disable or re-enable voice without changing your config:

```bash
# Disable voice for this shell session
export CLAUDE_SPEAK_ENABLED=false

# Re-enable
export CLAUDE_SPEAK_ENABLED=true
```

Or use the in-session subcommands for a more ergonomic toggle:

```
/speak off
/speak on
```

(`/speak mute` and `/speak unmute` work the same way, as aliases.)

You can also disable individual hooks in your config:

```json
{
  "hooks": {
    "stop": false,
    "notification": false
  }
}
```

## Debugging

If voice isn't working, enable debug logging:

```bash
export CLAUDE_SPEAK_DEBUG=1
```

This writes detailed diagnostic output to stderr, including:

- Whether the plugin is enabled and which provider is active
- Whether API keys are set
- CLI arguments received
- Stdin content received from hooks
- Lock file status and cooldown state
- Extracted and sanitized text
- TTS errors

Errors are also logged to the log file (default: `~/.claude-speak/logs/voice.log`).

### Common Debug Checks

```bash
# Verify config exists and is valid
cat ~/.claude-speak.json

# Check the error log
cat ~/.claude-speak/logs/voice.log

# Check current status via CLI
node "$(cat ~/.claude-speak/plugin-root)/dist/cli.js" --cmd status

# Test speech directly
node "$(cat ~/.claude-speak/plugin-root)/dist/cli.js" --cmd test
```

## Architecture

```
claude-speak/
  src/
    cli.ts              # Entry point: argument parsing, pipeline orchestration
    config.ts           # Config loading, env var merging, auto-migration
    migration.ts        # Old-to-new config format detection and transform
    session.ts          # Per-session activation state (activate/deactivate/spokeThisTurn)
    subcommands.ts      # Subcommand dispatcher (on/off, voice, provider, etc.)
    condenser.ts        # Detects unlistenable text and applies the deterministic heuristic fallback
    summarizer.ts       # LLM rewrite tier of speech condensation
    voice-cache.ts      # ElevenLabs voice cache (fetch, read, resolve)
    extractor.ts        # Extracts assistant message from hook JSON stdin
    sanitizer.ts        # Strips markdown/HTML for natural speech
    lock.ts             # Timestamp lockfile for Notification-hook deduplication
    player.ts           # Platform-aware audio playback (afplay/paplay) and stop-epoch tracking
    error.ts            # Error logging and system beep on failure
    tts/
      interface.ts      # TTSProvider interface and TTSOptions type
      openai.ts         # OpenAI TTS implementation
      elevenlabs.ts     # ElevenLabs TTS implementation (raw fetch)
      factory.ts        # Provider factory (creates provider by name)
  bin/
    shutup              # Fast-path CLI for `!shutup` — stops playback with no model turn
  hooks/
    hooks.json          # Stop, Notification, SessionStart, and UserPromptSubmit hooks
  skills/
    speak/
      SKILL.md          # Active voice and subcommand skill definition
  scripts/
    check-setup.sh      # SessionStart setup validation and session garbage collection
  dist/
    cli.js              # Bundled output (single file, all deps included)
  CLAUDE.md             # Behavioral guidance injected into Claude's context
```

### Pipeline Flow

```
Hook fires (Stop/Notification)
  -> Check session activation -> exit if not activated with /speak on
  -> stdin JSON received
  -> Extract last_assistant_message
  -> Stop: check turn-scoped "spoke this turn" flag -> exit if set
  -> Notification: check lock file (cooldown active?) -> exit if yes
  -> Sanitize markdown to plain text
  -> Condense if long, tabular, or code-heavy (LLM rewrite, then heuristic fallback)
  -> Create TTS provider via factory (OpenAI or ElevenLabs)
  -> Send to provider API
  -> Exit early if a stop was requested since this pipeline started
  -> Write audio to temp file
  -> Spawn playback process (detached)
  -> CLI exits
```

### Key Design Decisions

- **Single bundled file**: esbuild compiles all TypeScript and dependencies into one `dist/cli.js`. No runtime `npm install` needed.
- **Detached playback**: The audio player runs as a detached subprocess so the CLI exits immediately without blocking Claude Code.
- **User-level config**: `~/.claude-speak.json` lives in your home directory, not per-project. Your voice preferences follow you across all repos.
- **Lock file in home dir**: `~/.claude-speak/voice.lock` is always in the home directory regardless of `CLAUDE_PLUGIN_DATA`. It now only governs the Notification-hook cooldown; Stop-hook dedup uses the turn-scoped flag instead.
- **No SDK for ElevenLabs**: Uses raw `fetch` against the convert endpoint to keep dependencies light. The endpoint is a single POST.
- **Per-session state via files**: `~/.claude-speak/sessions/<session_id>.json` holds each session's activation and turn-scoped flag. Sessions are independent, so a second window can never unmute the first. Stale session files and the legacy 1.x `~/.claude-speak/session.json` are garbage-collected on `SessionStart`.

## Platform Support

| Platform | Status | Audio Player |
|----------|--------|-------------|
| macOS | Fully supported | `afplay` (built-in) |
| Linux | Supported | `paplay` (PulseAudio) or `aplay` (ALSA) |
| Windows | Not supported | No playback command defined |

## Troubleshooting

### No audio plays

1. Check that you ran `/speak on` for this session — voice is off by default and does not persist from a previous session
2. Check that `~/.claude-speak.json` exists and is valid JSON
3. Check that your API key is configured (reinstall plugin or check shell environment)
4. Run `/speak status` to verify the plugin sees your config and that the session is active
5. Run `/speak test` to test the full pipeline
6. Run the [debug checks](#common-debug-checks) above

### Voice speaks twice

Stop-hook double-speech (active voice, then the end-of-turn hook repeating it) is prevented by an exact per-turn flag and should not happen. If you see it anyway, check the [debug log](#debugging) for whether the Stop hook fired before the flag was set — please file an issue with the log excerpt.

If instead a `Notification` event repeats close to another spoken event, your `cooldown` value may be too low. Increase it in `~/.claude-speak.json`:

```json
{
  "cooldown": 20
}
```

### Voice never stops (overlapping audio)

Type `!shutup` to cut off in-flight narration instantly (see [Interrupting speech](#interrupting-speech)), or submit a prompt, which stops it automatically. Use `/speak off` to silence voice for the rest of the session.

### "No API key" errors

The hooks can't find your API key. Ensure one of these is true for your active provider:

**OpenAI:**
- API key configured via plugin installation (stored in system keychain)
- Or `OPENAI_API_KEY` set in your shell profile

**ElevenLabs:**
- API key configured via plugin installation (stored in system keychain)
- Or `ELEVENLABS_API_KEY` set in your shell profile

### "No voice configured for ElevenLabs"

You switched to ElevenLabs but haven't selected a voice yet. Run:

```
/speak voices
/speak voice <name>
```

### Setup instructions appear every session

The `SessionStart` hook detected missing configuration. Follow the instructions it displays, then restart Claude Code.

## Development

```bash
# Install dependencies
npm install

# Build (compiles TypeScript to dist/cli.js via esbuild)
npm run build

# Type check without emitting
npm run typecheck

# Run tests
npm test

# Watch mode for tests
npm run test:watch
```

## License

MIT
