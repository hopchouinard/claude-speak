#!/bin/bash
# check-setup.sh — Runs on SessionStart to verify claude-voice is configured.
# Outputs setup instructions as additionalContext if config is missing.
# API keys are NEVER prompted for within Claude Code — users set them manually.

CONFIG_FILE="$HOME/.claude-voice.json"
EXAMPLE_CONFIG="${CLAUDE_PLUGIN_ROOT}/claude-voice.example.json"
HAS_ISSUES=false
ISSUES=""

# Check for API key
if [ -z "$OPENAI_API_KEY" ] && [ -z "$CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY" ]; then
  HAS_ISSUES=true
  ISSUES="${ISSUES}\n- **OPENAI_API_KEY not set.** Add \`export OPENAI_API_KEY=sk-your-key-here\` to your shell profile (~/.zshrc or ~/.bashrc), then restart your terminal."
fi

# Check for config file
if [ ! -f "$CONFIG_FILE" ]; then
  HAS_ISSUES=true
  ISSUES="${ISSUES}\n- **Config file missing.** Run: \`cp ${EXAMPLE_CONFIG} ~/.claude-voice.json\` then edit ~/.claude-voice.json to set your voice, delivery instructions, and preferences."
fi

if [ "$HAS_ISSUES" = true ]; then
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "## claude-voice Plugin — Setup Required\n\nThe claude-voice plugin is installed but not fully configured:\n${ISSUES}\n\nIMPORTANT: Do NOT ask the user for their API key. Direct them to set it in their shell profile manually. Never handle API keys within a Claude Code session.\n\nOnce configured, restart Claude Code. Your responses will be spoken aloud automatically, and you can use the speak skill to speak deliberately during a turn."
  }
}
EOF
else
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}'
fi
