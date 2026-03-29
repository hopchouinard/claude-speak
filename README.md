# claude-speak

Voice output layer for Claude Code. Speaks Claude's responses aloud so you can work hands-free.

## Features

- **Passive voice** — Automatically speaks Claude's final message at the end of each turn
- **Active voice** — Claude can choose to speak when something warrants your audible attention
- **Configurable TTS** — Voice, model, delivery instructions, all tunable
- **Provider-agnostic** — Defaults to OpenAI gpt-4o-mini-tts, swappable via interface

## Installation

Install as a Claude Code plugin:

```bash
claude plugin install claude-speak
```

You'll be prompted for your OpenAI API key during installation (stored securely in your system keychain).

## Configuration

Copy the example config and customize:

```bash
cp claude-speak.example.json ~/.claude-speak.json
```

Edit `~/.claude-speak.json` to set your preferred voice, delivery instructions, and hook preferences.

### Quick toggle

```bash
# Disable voice temporarily
export CLAUDE_SPEAK_ENABLED=false

# Re-enable
export CLAUDE_SPEAK_ENABLED=true
```

## How it works

### Passive mode
When Claude finishes a turn, the `Stop` hook captures the last message, strips markdown formatting, sends it to the TTS API, and plays the audio locally.

### Active mode
Claude knows it has a voice (via the bundled skill and CLAUDE.md). It can choose to speak during a turn for critical failures, blocking decisions, or anything you should hear without looking at the screen.

## License

MIT
