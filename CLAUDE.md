## Voice Output Capability

This Claude Code session has voice output enabled via the claude-voice plugin.

### Passive Voice (automatic)
Your final message at the end of each turn is automatically spoken aloud to the user via text-to-speech. You do not need to do anything for this to work. Write your final messages knowing they may be heard as well as read.

### Active Voice (deliberate)
You can also choose to speak to the user at any point during your turn using the `voice` skill. Use this when something is important enough to warrant the user's immediate audible attention, even if they are not watching the screen.

Invoke it by running:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" --say "<message>"
```

### Guidelines
- Do not overuse active voice. If your end-of-turn message will cover it, let the passive hook handle it.
- When you use active voice, write for the ear: short, direct, natural speech.
- The user has configured a personality and tone for TTS delivery. Your text carries the content and meaning; the TTS system handles vocal delivery.
- A cooldown prevents speaking too frequently. If your active voice call is silently skipped, it means you spoke recently — this is expected behavior.
