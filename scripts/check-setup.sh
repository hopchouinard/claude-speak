#!/bin/bash
# check-setup.sh — Runs on SessionStart to verify claude-speak is configured.
# Outputs setup instructions as additionalContext if config is missing.
# API keys are NEVER prompted for within Claude Code — users set them manually.

CONFIG_FILE="$HOME/.claude-speak.json"
ENV_FILE="$HOME/.claude-speak/env"
EXAMPLE_CONFIG="${CLAUDE_PLUGIN_ROOT}/claude-speak.example.json"
HAS_ISSUES=false
ISSUES=""

# Clean session state from previous session (fresh start)
rm -f "$HOME/.claude-speak/session.json"

# Check for env file with API key (accept OpenAI or ElevenLabs)
HAS_API_KEY=false
if [ -f "$ENV_FILE" ]; then
  if grep -q "OPENAI_API_KEY" "$ENV_FILE" 2>/dev/null || grep -q "ELEVENLABS_API_KEY" "$ENV_FILE" 2>/dev/null; then
    HAS_API_KEY=true
  fi
fi
if [ -n "$OPENAI_API_KEY" ] || [ -n "$CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY" ] || [ -n "$ELEVENLABS_API_KEY" ] || [ -n "$CLAUDE_PLUGIN_OPTION_ELEVENLABS_API_KEY" ]; then
  HAS_API_KEY=true
fi
if [ "$HAS_API_KEY" = false ]; then
  HAS_ISSUES=true
  ISSUES="${ISSUES}\n- **API key not configured.** Create the file \`~/.claude-speak/env\` with your provider key:\n  \`export OPENAI_API_KEY=sk-your-key-here\` (for OpenAI)\n  \`export ELEVENLABS_API_KEY=your-key-here\` (for ElevenLabs)\n  This file is sourced by the voice hooks and keeps your key out of Claude's context."
fi

# Check for config file
if [ ! -f "$CONFIG_FILE" ]; then
  HAS_ISSUES=true
  ISSUES="${ISSUES}\n- **Config file missing.** Run: \`cp ${EXAMPLE_CONFIG} ~/.claude-speak.json\` then edit ~/.claude-speak.json to set your voice, delivery instructions, and preferences."
fi

if [ "$HAS_ISSUES" = true ]; then
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "## claude-speak Plugin — Setup Required\n\nThe claude-speak plugin is installed but not fully configured:\n${ISSUES}\n\nIMPORTANT: Do NOT ask the user for their API key. Direct them to set it in ~/.claude-speak/env manually. Never handle API keys within a Claude Code session.\n\nOnce configured, restart Claude Code. Your responses will be spoken aloud automatically, and you can use the speak skill to speak deliberately during a turn."
  }
}
EOF
else
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}'
fi
