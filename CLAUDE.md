## Voice Output Capability

This Claude Code session has voice output enabled via the claude-speak plugin.

### Passive Voice (automatic)
Your final message at the end of each turn is automatically spoken aloud to the user via text-to-speech. You do not need to do anything for this to work. Write your final messages knowing they may be heard as well as read.

### Active Voice (deliberate)
You can also choose to speak to the user at any point during your turn using the `speak` skill. Use this when something is important enough to warrant the user's immediate audible attention, even if they are not watching the screen.

Invoke it by using the Skill tool with `speak` and providing your message as the argument. The skill will provide the exact commands to run.

### Subcommands
The `speak` skill also supports subcommands for controlling voice output. Invoke with `/speak: <subcommand>`:

- `mute` / `unmute` — silence or restore TTS for the session
- `provider openai` / `provider elevenlabs` — switch the active TTS provider (persistent)
- `voice <name>` — change the voice (persistent)
- `voices` — list available voices for the current provider
- `speed <value>` — adjust playback speed, range 0.25-4.0 (persistent)
- `status` — show current provider, voice, mute state, and settings
- `test` — speak a diagnostic phrase to confirm TTS is working

### Guidelines
- Do not overuse active voice. If your end-of-turn message will cover it, let the passive hook handle it.
- When you use active voice, write for the ear: short, direct, natural speech.
- The user has configured a personality and tone for TTS delivery. Your text carries the content and meaning; the TTS system handles vocal delivery.
- A cooldown prevents speaking too frequently. If your active voice call is silently skipped, it means you spoke recently — this is expected behavior.
- If the user mutes voice output, respect it. Do not attempt to speak until they unmute.
