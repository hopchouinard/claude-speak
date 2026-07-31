## Voice Output Capability

This Claude Code session has voice output available via the claude-speak plugin.

### Voice is off by default

Voice output is **inactive** in every new session until the user runs
`/speak on`. This is deliberate: activation is a conscious per-session
decision, so no project ever starts talking unexpectedly.

The SessionStart hook tells you the current state. While voice is off, do not
use the `speak` skill and do not shape final messages for the ear.

### Passive Voice (automatic)

Once activated, your final message at the end of each turn is spoken aloud
automatically. You do not need to do anything for this to work.

If that message will contain a table, a code block, or otherwise run long,
speak a two-sentence version yourself via the `speak` skill as your last
action before finishing. Otherwise the plugin condenses it automatically,
which works but guesses at what mattered.

### Active Voice (deliberate)
You can also choose to speak to the user at any point during your turn using the `speak` skill. Use this when something is important enough to warrant the user's immediate audible attention, even if they are not watching the screen.

Invoke it by using the Skill tool with `speak` and providing your message as the argument. The skill will provide the exact commands to run.

### Subcommands
The `speak` skill also supports subcommands for controlling voice output. Invoke with `/speak <subcommand>`:

- `on` / `off` — activate or deactivate voice for this session (off by default)
- `mute` / `unmute` — aliases for `off` / `on`
- `provider openai` / `provider elevenlabs` — switch the active TTS provider (persistent)
- `voice <name>` — change the voice (persistent)
- `voices` — list available voices for the current provider
- `speed <value>` — adjust playback speed, range 0.25-4.0 (persistent)
- `status` — show current provider, voice, activation state, and settings
- `test` — speak a diagnostic phrase to confirm TTS is working

### Guidelines
- Do not overuse active voice. If your end-of-turn message will cover it, let the passive hook handle it.
- When you use active voice, write for the ear: short, direct, natural speech.
- The user has configured a personality and tone for TTS delivery. Your text carries the content and meaning; the TTS system handles vocal delivery.
- A cooldown prevents speaking too frequently. If your active voice call is silently skipped, it means you spoke recently — this is expected behavior.
- If the user mutes voice output, respect it. Do not attempt to speak until they unmute.
- The user can cut off narration with `!shutup` or by submitting a prompt. If speech stops early, that was deliberate — do not repeat it.
