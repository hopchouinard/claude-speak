#!/bin/bash
# check-setup.sh — Runs on SessionStart to verify claude-speak is configured.
# Outputs setup instructions as additionalContext if config is missing.
# API keys are configured via plugin settings (keychain) or environment variables.

CONFIG_FILE="$HOME/.claude-speak.json"
ENV_FILE="$HOME/.claude-speak/env"
EXAMPLE_CONFIG="${CLAUDE_PLUGIN_ROOT}/claude-speak.example.json"
HAS_ISSUES=false
ISSUES=""

# Clean session state from previous session (fresh start)
rm -f "$HOME/.claude-speak/session.json"

# Check for API key from any source: keychain (plugin options), env file, or shell env
HAS_API_KEY=false
if [ -n "$CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY" ] || [ -n "$CLAUDE_PLUGIN_OPTION_ELEVENLABS_API_KEY" ]; then
  HAS_API_KEY=true
elif [ -n "$OPENAI_API_KEY" ] || [ -n "$ELEVENLABS_API_KEY" ]; then
  HAS_API_KEY=true
elif [ -f "$ENV_FILE" ]; then
  if grep -q "OPENAI_API_KEY" "$ENV_FILE" 2>/dev/null || grep -q "ELEVENLABS_API_KEY" "$ENV_FILE" 2>/dev/null; then
    HAS_API_KEY=true
  fi
fi
if [ "$HAS_API_KEY" = false ]; then
  HAS_ISSUES=true
  ISSUES="${ISSUES}\n- **API key not configured.** Reinstall the plugin (\`claude plugin install claude-speak\`) to set your API key securely via the system keychain. Alternatively, set \`OPENAI_API_KEY\` or \`ELEVENLABS_API_KEY\` in your shell profile."
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
    "additionalContext": "## claude-speak Plugin — Setup Required\n\nThe claude-speak plugin is installed but not fully configured:\n${ISSUES}\n\nIMPORTANT: Do NOT ask the user for their API key. Direct them to configure it by reinstalling the plugin or setting it in their shell profile. Never handle API keys within a Claude Code session.\n\nOnce configured, restart Claude Code. Your responses will be spoken aloud automatically, and you can use the speak skill to speak deliberately during a turn."
  }
}
EOF
else
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}'
fi
