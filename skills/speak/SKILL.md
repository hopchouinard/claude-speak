---
name: speak
description: Speak to the user audibly through text-to-speech. Use when the user may not be watching the screen and something warrants their audible attention. This is NOT the built-in Claude Code voice mode — this uses the claude-speak plugin to generate speech via TTS.
---

# Voice Output

You have the ability to speak to the user audibly using text-to-speech.

## How to invoke

Run these two commands in sequence via the Bash tool. The first writes a lock file that prevents the end-of-turn hook from speaking over you. The second does the actual speech.

**Step 1 — Write the lock (must run first, in its own Bash call):**
```bash
mkdir -p ~/.claude-speak && date +%s000 > ~/.claude-speak/voice.lock
```

**Step 2 — Speak (separate Bash call, after step 1 completes):**
```bash
node /Volumes/NVMe_2TB_Work/Development/claude-speak/dist/cli.js --say "<your message here>"
```

Replace `<your message here>` with the exact text you want spoken. Write it as natural speech — short, direct sentences. No markdown, no code blocks, no file paths unless they are essential to understanding.

IMPORTANT: Always run step 1 before step 2. Never combine them into one command. The lock file prevents the passive end-of-turn hook from duplicating your message.

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
