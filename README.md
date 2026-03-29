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
- [Passive Voice (Automatic)](#passive-voice-automatic)
- [Active Voice (Deliberate)](#active-voice-deliberate)
- [Deduplication and Cooldown](#deduplication-and-cooldown)
- [Quick Toggle](#quick-toggle)
- [Debugging](#debugging)
- [Architecture](#architecture)
- [Platform Support](#platform-support)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Features

- **Passive voice** — Automatically speaks Claude's final message at the end of each turn via hooks
- **Active voice** — Claude can choose to speak mid-turn when something warrants your immediate audible attention (build failures, blocking questions, completed milestones)
- **Smart deduplication** — A lockfile-based cooldown prevents passive and active voice from double-speaking the same content
- **Markdown sanitization** — Strips headers, bold/italic, code fences, tables, links, and HTML before sending text to TTS, so speech sounds natural
- **Table-to-speech conversion** — Markdown tables are converted to "Header: Value" pairs for intelligible spoken output
- **Configurable TTS** — Voice, model, delivery instructions (tone, pacing, personality), and timing are all tunable
- **Provider-agnostic architecture** — Defaults to OpenAI `gpt-4o-mini-tts`, with a clean `TTSProvider` interface for adding new providers

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

### 3. OpenAI API Key

claude-speak uses OpenAI's TTS API to generate speech. You need an active OpenAI API key with access to the `gpt-4o-mini-tts` model (or whichever model you configure).

Get your API key at: https://platform.openai.com/api-keys

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

A minimal config looks like this:

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini-tts-2025-12-15",
  "voice": "ash",
  "instructions": "",
  "hooks": {
    "stop": true,
    "notification": true
  }
}
```

### Step 2: Configure the API Key

Even though you entered your API key during installation (stored in the system keychain), the hook scripts need access to it at runtime. Create an env file that the hooks will source:

```bash
mkdir -p ~/.claude-speak
echo 'export OPENAI_API_KEY=sk-your-key-here' > ~/.claude-speak/env
```

Replace `sk-your-key-here` with your actual OpenAI API key.

> **Why is this needed?** Hook scripts run as shell subprocesses outside of the plugin sandbox. They source `~/.claude-speak/env` to get the API key into their environment. This keeps your key out of Claude's conversation context and separate from any project files.

Alternatively, if `OPENAI_API_KEY` is already set in your shell profile (`.zshrc`, `.bashrc`, etc.), you can skip this step. The hooks will pick it up from the environment.

### Step 3: Restart Claude Code

After completing the setup, restart your Claude Code session. On the next `SessionStart`, the plugin will verify your configuration and hooks will begin firing automatically.

> **Setup verification:** If something is misconfigured, the plugin's `SessionStart` hook will display setup instructions at the top of your session telling you exactly what's missing.

## Configuration Reference

The configuration file lives at `~/.claude-speak.json`. All fields are optional and fall back to sensible defaults.

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini-tts-2025-12-15",
  "voice": "Marin",
  "instructions": "Speak in a cheeky, conversational tone. Be direct and concise.",
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

### Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `string` | `"openai"` | TTS provider. Currently only `"openai"` is supported. |
| `model` | `string` | `"gpt-4o-mini-tts-2025-12-15"` | OpenAI TTS model to use. |
| `voice` | `string` | `"ash"` | Voice name. For `gpt-4o-mini-tts`, options include `ash`, `ballad`, `coral`, `sage`, `verse`, and others. See [OpenAI's voice docs](https://platform.openai.com/docs/guides/text-to-speech) for the full list. |
| `instructions` | `string` | `""` | Delivery instructions sent to the TTS model. Controls tone, pacing, and personality of the spoken output. Example: `"Speak in a calm, measured tone with slight pauses between sentences."` |
| `hooks.stop` | `boolean` | `true` | Enable the Stop hook (speaks Claude's final message at end of turn). |
| `hooks.notification` | `boolean` | `true` | Enable the Notification hook (speaks when Claude sends a notification). |
| `playback.command` | `string` | Auto-detected | Audio playback command. Auto-detects `afplay` on macOS or `paplay` on Linux. Override if you prefer a different player. |
| `cooldown` | `number` | `15` | Seconds after an active voice event during which the passive hook will not fire. Prevents double-speaking. |
| `timeout` | `number` | `30` | Maximum seconds to wait for the TTS API before giving up. |
| `logFile` | `string` | `"~/.claude-speak/logs/voice.log"` | Path to the error log file. Supports `~/` expansion. |

### Voice Instructions Tips

The `instructions` field is powerful. It controls how the TTS model delivers your text, not what it says. Some ideas:

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

When Claude finishes a turn, the plugin's `Stop` hook fires automatically. Here's what happens:

1. Claude Code invokes the `Stop` hook, passing the session context (including the last assistant message) as JSON on stdin
2. The hook script sources `~/.claude-speak/env` to get the API key
3. The CLI extracts the `last_assistant_message` from the JSON
4. The sanitizer strips all markdown formatting (headers, bold, italic, code fences, tables, links, HTML tags) into clean natural text
5. The sanitized text is sent to the OpenAI TTS API
6. The resulting audio is written to a temp file and played via `afplay`/`paplay`
7. The playback process is detached so the CLI exits immediately without blocking Claude Code

There is a built-in 2-second delay before the Stop hook fires, giving you time to start reading the response before audio begins.

### Active Voice (Deliberate)

Claude also has a bundled skill called `speak` that lets it deliberately speak during a turn. Claude will use this for:

- **Critical failures** — a build broke, a deploy failed, a test suite collapsed
- **Blocking decisions** — Claude needs your input before continuing
- **Completed milestones** — a long-running task finished successfully
- **Security or data concerns** — something you must know about immediately
- **You're not watching** — anything important enough that it shouldn't wait for you to glance at the screen

When active voice fires, it writes a lock file before speaking. This prevents the end-of-turn passive hook from repeating the same information moments later.

Claude will **not** use active voice for routine status updates, command acknowledgments, or information that only makes sense on screen (code diffs, file contents, long lists).

### Deduplication and Cooldown

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

- Whether the plugin is enabled
- Whether an API key is set
- CLI arguments received
- Stdin content received from hooks
- Lock file status and cooldown state
- Extracted and sanitized text
- TTS errors

Errors are also logged to the log file (default: `~/.claude-speak/logs/voice.log`).

### Common Debug Checks

```bash
# Verify config exists
cat ~/.claude-speak.json

# Verify API key env file exists and has your key
cat ~/.claude-speak/env

# Check the error log
cat ~/.claude-speak/logs/voice.log

# Verify the plugin root was saved
cat ~/.claude-speak/plugin-root

# Test the CLI directly
echo '{"last_assistant_message":"Hello, testing voice output."}' | node "$(cat ~/.claude-speak/plugin-root)/dist/cli.js" --trigger stop
```

## Architecture

```
claude-speak/
├── src/
│   ├── cli.ts            # Entry point: argument parsing, pipeline orchestration
│   ├── config.ts         # Config loading, env var merging, platform detection
│   ├── extractor.ts      # Extracts assistant message from hook JSON stdin
│   ├── sanitizer.ts      # Strips markdown/HTML for natural speech
│   ├── lock.ts           # Timestamp lockfile for active/passive deduplication
│   ├── player.ts         # Platform-aware audio playback (afplay/paplay)
│   ├── error.ts          # Error logging and system beep on failure
│   └── tts/
│       ├── interface.ts   # TTSProvider interface (provider-agnostic)
│       └── openai.ts      # OpenAI gpt-4o-mini-tts implementation
├── hooks/
│   └── hooks.json         # Stop, Notification, and SessionStart hooks
├── skills/
│   └── speak/
│       └── SKILL.md       # Active voice skill definition
├── scripts/
│   └── check-setup.sh    # SessionStart setup validation
├── dist/
│   └── cli.js            # Bundled output (single file, all deps included)
└── CLAUDE.md              # Behavioral guidance injected into Claude's context
```

### Pipeline Flow

```
Hook fires (Stop/Notification)
  → stdin JSON received
  → Extract last_assistant_message
  → Check if locked (cooldown active?) → exit if yes
  → Sanitize markdown to plain text
  → Send to OpenAI TTS API
  → Write audio to temp file
  → Spawn playback process (detached)
  → CLI exits
```

### Key Design Decisions

- **Single bundled file**: esbuild compiles all TypeScript and dependencies into one `dist/cli.js`. No runtime `npm install` needed.
- **Detached playback**: The audio player runs as a detached subprocess so the CLI (and hook) exits immediately without blocking Claude Code.
- **User-level config**: `~/.claude-speak.json` lives in your home directory, not per-project. Your voice preferences follow you across all repos.
- **Lock file in home dir**: `~/.claude-speak/voice.lock` is always in the home directory regardless of `CLAUDE_PLUGIN_DATA`, so active voice (invoked via Bash) and passive voice (invoked via hooks) always read/write the same file.

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
3. Run the [debug checks](#common-debug-checks) above
4. Verify your OpenAI API key has access to the TTS model: `gpt-4o-mini-tts-2025-12-15`

### Voice speaks twice

Your `cooldown` value may be too low. Increase it in `~/.claude-speak.json`:

```json
{
  "cooldown": 20
}
```

### Voice never stops (overlapping audio)

Each turn's audio plays independently. If Claude is responding quickly across multiple turns, audio from previous turns may overlap. Increase the Stop hook delay or use `CLAUDE_SPEAK_ENABLED=false` to mute temporarily.

### "No API key configured" in log

The hooks can't find your OpenAI API key. Ensure one of these is true:

- `~/.claude-speak/env` contains `export OPENAI_API_KEY=sk-...`
- `OPENAI_API_KEY` is set in your shell profile
- `CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY` is set (via plugin installation)

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
