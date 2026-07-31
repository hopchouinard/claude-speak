#!/bin/bash
# check-setup.sh — Runs on SessionStart to verify claude-speak is configured.
# Outputs setup instructions as additionalContext if config is missing.
# API keys are configured via plugin settings (keychain) or environment variables.
#
# SessionStart also fires on `compact` and `resume`, not just `startup`. A
# resumed or compacted session keeps its session_id, so its activation state
# survives — which means this script must report the *actual* state rather than
# assuming a fresh, silent session. Claiming voice is off while the Stop hook is
# still speaking costs the best tier of the condensation chain (Claude writing
# its own spoken summary) for the rest of the session.

CONFIG_FILE="$HOME/.claude-speak.json"
ENV_FILE="$HOME/.claude-speak/env"
EXAMPLE_CONFIG="${CLAUDE_PLUGIN_ROOT}/claude-speak.example.json"
HAS_ISSUES=false
ISSUES=""

# Capture the hook payload before anything else can consume it. The gc call
# below runs a node process that reads stdin to EOF, which would otherwise
# swallow the payload and leave the session id unknowable.
PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi

# Garbage-collect stale per-session state (and the legacy 1.x session.json).
# Explicitly given no stdin: it needs none, and inheriting ours would block.
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" --cmd gc >/dev/null 2>&1 </dev/null || true

# Resolve the session id from the payload. No jq dependency: the field is a
# plain JSON string. An id containing anything but the safe characters below is
# treated as unresolvable rather than being interpolated into a path.
SESSION_ID=$(printf '%s' "$PAYLOAD" | tr -d '\n' | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
case "$SESSION_ID" in
  *[!A-Za-z0-9._-]*) SESSION_ID="" ;;
esac

# Voice state: active, off, or unknown. Never guess — a confident wrong claim
# is worse than an admitted uncertainty.
VOICE_STATE="unknown"
if [ -n "$SESSION_ID" ]; then
  if [ -f "$HOME/.claude-speak/sessions/${SESSION_ID}.json" ]; then
    VOICE_STATE="active"
  else
    VOICE_STATE="off"
  fi
fi

# Single-quoted so backticks stay literal and \n stays a JSON escape.
MSG_ACTIVE='## claude-speak\n\nVoice output is **active** for this session. It stays active across compaction and resume, and until `/speak off` or the end of the session.\n\n- Your final message each turn is spoken aloud. Write it so it works when heard, not only when read.\n- If a final message will contain a table, a code block, or otherwise run long, speak a two-sentence version yourself with the speak skill as your last action. Otherwise the plugin condenses it, which works but guesses at what mattered.\n- The user can silence in-flight narration at any time by typing `!shutup`, or by submitting a prompt.'

MSG_OFF='## claude-speak\n\nVoice output is **off** for this session. It is off by default in every session and must be activated deliberately.\n\n- To activate: run `/speak on`.\n- Until then, do NOT write final messages for the ear and do NOT use the speak skill — nothing will be audible.\n- The user can silence in-flight narration at any time by typing `!shutup`.'

MSG_UNKNOWN='## claude-speak\n\nVoice output state for this session could NOT be determined (no session id was available on the SessionStart payload).\n\n- Run `/speak status` before assuming either way.\n- Until you have confirmed voice is active, do not use the speak skill and do not write final messages for the ear.\n- `/speak on` activates voice for this session if it is not already on.'

emit_context() {
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "$1"
  }
}
EOF
}

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
elif [ "$VOICE_STATE" = "active" ]; then
  emit_context "$MSG_ACTIVE"
elif [ "$VOICE_STATE" = "off" ]; then
  emit_context "$MSG_OFF"
else
  emit_context "$MSG_UNKNOWN"
fi

exit 0
