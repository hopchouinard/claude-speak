# claude-speak

Voice output layer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Converts Claude's text responses into natural speech and plays them through your local speakers, so you can work hands-free.

This is **not** a voice input system and it is **not** the built-in Claude Code voice mode. It is a dedicated text-to-speech plugin that gives Claude the ability to speak its responses aloud, either automatically at the end of every turn or deliberately when something warrants your audible attention.

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Post-Installation Setup](#post-installation-setup)
- [Configuration Reference](#configuration-reference)
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
- **Session mute/unmute** -- Mute and unmute voice output within a session without editing config files; every new session starts fresh
- **Multi-provider TTS** -- Supports both OpenAI (`gpt-4o-mini-tts`) and ElevenLabs, with full configuration for each provider stored side by side
- **Subcommand system** -- Control provider, voice, speed, mute, and more via `/speak:` subcommands without leaving your session
- **Smart deduplication** -- A lockfile-based cooldown prevents passive and active voice from double-speaking the same content
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

Create an env file that the hooks will source at runtime:

```bash
mkdir -p ~/.claude-speak
cat > ~/.claude-speak/env << 'EOF'
export OPENAI_API_KEY=sk-your-key-here
export ELEVENLABS_API_KEY=xi-your-key-here
EOF
```

Replace with your actual API keys. You only need to include the key(s) for the provider(s) you plan to use.

> **Why is this needed?** Hook scripts run as shell subprocesses outside of the plugin sandbox. They source `~/.claude-speak/env` to get API keys into their environment. This keeps your keys out of Claude's conversation context and separate from any project files.

Alternatively, if your API keys are already set in your shell profile (`.zshrc`, `.bashrc`, etc.), you can skip this step.

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
  "cooldown": 10,
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

## How It Works

claude-speak operates in two modes that work together:

### Passive Voice (Automatic)

When Claude finishes a turn, the plugin's `Stop` hook fires automatically:

1. Claude Code invokes the `Stop` hook, passing the session context as JSON on stdin
2. The hook sources `~/.claude-speak/env` to get API keys
3. The CLI extracts the `last_assistant_message` from the JSON
4. The sanitizer strips all markdown formatting into clean natural text
5. The sanitized text is sent to the active TTS provider's API
6. The resulting audio is written to a temp file and played via `afplay`/`paplay`
7. The playback process is detached so the CLI exits immediately without blocking Claude Code

There is a built-in 2-second delay before the Stop hook fires, giving you time to start reading the response before audio begins.

### Active Voice (Deliberate)

Claude has a bundled skill called `speak` that lets it deliberately speak during a turn. Claude will use this for:

- **Critical failures** -- a build broke, a deploy failed, a test suite collapsed
- **Blocking decisions** -- Claude needs your input before continuing
- **Completed milestones** -- a long-running task finished successfully
- **Security or data concerns** -- something you must know about immediately
- **You're not watching** -- anything important enough that it shouldn't wait for you to glance at the screen

When active voice fires, it writes a lock file before speaking. This prevents the end-of-turn passive hook from repeating the same information.

## Session Controls

claude-speak provides subcommands you can invoke during a session via `/speak:` in Claude Code:

| Command | Effect |
|---------|--------|
| `/speak mute` | Mute all TTS for this session |
| `/speak unmute` | Re-enable TTS (speaks a confirmation to prove it works) |
| `/speak provider openai` | Switch to OpenAI TTS (persistent) |
| `/speak provider elevenlabs` | Switch to ElevenLabs TTS (persistent) |
| `/speak voice Marin` | Change the speaking voice (persistent) |
| `/speak voices` | List available voices for the current provider |
| `/speak speed 1.2` | Adjust speech speed, 0.25-4.0 (persistent) |
| `/speak status` | Show current provider, voice, speed, mute state |
| `/speak test` | Speak a diagnostic phrase to verify everything works |

**Session vs. persistent changes:**
- **Mute/unmute** is session-only. Every new session starts unmuted.
- **Provider, voice, and speed** changes write to `~/.claude-speak.json` and persist across sessions.

## Multi-Provider Support

claude-speak supports both OpenAI and ElevenLabs TTS providers. Both can be fully configured in your config file simultaneously; you switch between them with `/speak provider`.

### Setting Up ElevenLabs

1. Add your ElevenLabs API key to `~/.claude-speak/env`:
   ```bash
   echo 'export ELEVENLABS_API_KEY=xi-your-key-here' >> ~/.claude-speak/env
   ```

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

### Voice Cache

When you run `/speak voices` with ElevenLabs active, the plugin calls the ElevenLabs API to fetch voices in your account and caches them locally at `~/.claude-speak/voices-elevenlabs.json`. This cache is used for name-to-ID resolution so you can configure voices by name instead of UUID.

To refresh the cache (e.g., after adding new voices to your ElevenLabs account), run `/speak voices` again.

OpenAI voices are hardcoded (the list is small and static) and don't require caching.

## Deduplication and Cooldown

To prevent active and passive voice from speaking over each other:

1. When active voice fires, it writes a timestamp to `~/.claude-speak/voice.lock`
2. When the passive Stop hook fires, it checks the lock file
3. If the lock timestamp is within the `cooldown` window (default: 15 seconds), the passive hook exits silently
4. After the cooldown expires, passive voice resumes normally

This means if Claude speaks actively at second 0, the Stop hook at second 2 won't double-speak. But if Claude doesn't speak actively, the Stop hook works as normal.

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
/speak mute
/speak unmute
```

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

# Verify API keys are set
cat ~/.claude-speak/env

# Check the error log
cat ~/.claude-speak/logs/voice.log

# Check current status via CLI
node "$(cat ~/.claude-speak/plugin-root)/dist/cli.js" --cmd status

# Test speech directly
source ~/.claude-speak/env && node "$(cat ~/.claude-speak/plugin-root)/dist/cli.js" --say "Hello, testing voice output."
```

## Architecture

```
claude-speak/
  src/
    cli.ts              # Entry point: argument parsing, pipeline orchestration
    config.ts           # Config loading, env var merging, auto-migration
    migration.ts        # Old-to-new config format detection and transform
    session.ts          # Session state (mute) loading and persistence
    subcommands.ts      # Subcommand dispatcher (mute, voice, provider, etc.)
    voice-cache.ts      # ElevenLabs voice cache (fetch, read, resolve)
    extractor.ts        # Extracts assistant message from hook JSON stdin
    sanitizer.ts        # Strips markdown/HTML for natural speech
    lock.ts             # Timestamp lockfile for active/passive deduplication
    player.ts           # Platform-aware audio playback (afplay/paplay)
    error.ts            # Error logging and system beep on failure
    tts/
      interface.ts      # TTSProvider interface and TTSOptions type
      openai.ts         # OpenAI TTS implementation
      elevenlabs.ts     # ElevenLabs TTS implementation (raw fetch)
      factory.ts        # Provider factory (creates provider by name)
  hooks/
    hooks.json          # Stop, Notification, and SessionStart hooks
  skills/
    speak/
      SKILL.md          # Active voice and subcommand skill definition
  scripts/
    check-setup.sh      # SessionStart setup validation and session cleanup
  dist/
    cli.js              # Bundled output (single file, all deps included)
  CLAUDE.md             # Behavioral guidance injected into Claude's context
```

### Pipeline Flow

```
Hook fires (Stop/Notification)
  -> Check mute state -> exit if muted
  -> stdin JSON received
  -> Extract last_assistant_message
  -> Check if locked (cooldown active?) -> exit if yes
  -> Sanitize markdown to plain text
  -> Create TTS provider via factory (OpenAI or ElevenLabs)
  -> Send to provider API
  -> Write audio to temp file
  -> Spawn playback process (detached)
  -> CLI exits
```

### Key Design Decisions

- **Single bundled file**: esbuild compiles all TypeScript and dependencies into one `dist/cli.js`. No runtime `npm install` needed.
- **Detached playback**: The audio player runs as a detached subprocess so the CLI exits immediately without blocking Claude Code.
- **User-level config**: `~/.claude-speak.json` lives in your home directory, not per-project. Your voice preferences follow you across all repos.
- **Lock file in home dir**: `~/.claude-speak/voice.lock` is always in the home directory regardless of `CLAUDE_PLUGIN_DATA`, so active and passive voice always read/write the same file.
- **No SDK for ElevenLabs**: Uses raw `fetch` against the convert endpoint to keep dependencies light. The endpoint is a single POST.
- **Session state via file**: `~/.claude-speak/session.json` holds transient state (mute). Cleaned up on every `SessionStart` so each session starts fresh.

## Platform Support

| Platform | Status | Audio Player |
|----------|--------|-------------|
| macOS | Fully supported | `afplay` (built-in) |
| Linux | Supported | `paplay` (PulseAudio) or `aplay` (ALSA) |
| Windows | Not supported | No playback command defined |

## Troubleshooting

### No audio plays

1. Check that `~/.claude-speak.json` exists and is valid JSON
2. Check that your API key is set in `~/.claude-speak/env` (or in your shell environment)
3. Run `/speak status` to verify the plugin sees your config
4. Run `/speak test` to test the full pipeline
5. Run the [debug checks](#common-debug-checks) above

### Voice speaks twice

Your `cooldown` value may be too low. Increase it in `~/.claude-speak.json`:

```json
{
  "cooldown": 20
}
```

### Voice never stops (overlapping audio)

Each turn's audio plays independently. If Claude is responding quickly across multiple turns, audio from previous turns may overlap. Use `/speak mute` to silence voice temporarily, or increase the cooldown.

### "No API key" errors

The hooks can't find your API key. Ensure one of these is true for your active provider:

**OpenAI:**
- `~/.claude-speak/env` contains `export OPENAI_API_KEY=sk-...`
- `OPENAI_API_KEY` is set in your shell profile
- `CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY` is set (via plugin installation)

**ElevenLabs:**
- `~/.claude-speak/env` contains `export ELEVENLABS_API_KEY=xi-...`
- `ELEVENLABS_API_KEY` is set in your shell profile

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
