---
name: speak
description: Speak to the user audibly through text-to-speech. Use when the user may not be watching the screen and something warrants their audible attention. This is NOT the built-in Claude Code voice mode — this uses the claude-voice plugin to generate speech via TTS.
---

# Voice Output

You have the ability to speak to the user audibly using text-to-speech.

## How to invoke

Run this command via the Bash tool:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" --say "<your message here>"
```

Replace `<your message here>` with the exact text you want spoken. Write it as natural speech — short, direct sentences. No markdown, no code blocks, no file paths unless they are essential to understanding.

## When to use

- **Critical failures** — a build broke, a deploy failed, a test suite collapsed
- **Blocking decisions** — you need the user's input before you can continue
- **Completed milestones** — a long-running task finished successfully
- **Security or data concerns** — something the user must know about immediately
- **The user may not be watching** — any information important enough that it shouldn't wait for the user to glance at the screen

## When NOT to use

- **Routine status updates** — the passive voice hook already speaks your final message at the end of each turn
- **Acknowledging commands** — don't say "Got it" or "Working on it"
- **Information only useful on screen** — code diffs, file contents, long lists
- **Anything the end-of-turn hook will cover** — if you're about to finish your turn, don't duplicate the message

## Writing for the ear

- Keep it under 2-3 sentences
- Use natural speech patterns, not written prose
- Front-load the important information
- Avoid technical jargon unless the user will understand it in context
- No markdown formatting — the sanitizer strips it, but write clean text from the start
