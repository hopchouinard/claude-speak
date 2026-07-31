---
name: speak
description: Speak to the user audibly through text-to-speech. Use when the user may not be watching the screen and something warrants their audible attention. This is NOT the built-in Claude Code voice mode — this uses the claude-speak plugin to generate speech via TTS.
---

# Voice Output

You have the ability to speak to the user audibly using text-to-speech.

## Active Voice

Run this command via the Bash tool to speak.

The plugin root is derived from this skill's base directory (two levels up). When Claude Code loads this skill it prints a line like `Base directory for this skill: /path/to/skills/speak`. Use that path to build the CLI path below.

```bash
node "<SKILL_BASE_DIR>/../../dist/cli.js" --say "<your message here>"
```

Replace `<SKILL_BASE_DIR>` with the base directory shown when this skill was loaded (e.g. `/path/to/claude-speak/1.2.0/skills/speak`). Replace `<your message here>` with the exact text you want spoken. Write it as natural speech — short, direct sentences. No markdown, no code blocks, no file paths unless they are essential to understanding.

You do not need to write a lock file yourself. The CLI marks this turn as already spoken the moment it processes `--say`, before synthesis starts, so the end-of-turn hook will not repeat you later in the same turn.

## Subcommands

Subcommands are invoked with `--cmd` instead of `--say`.

```bash
node "<SKILL_BASE_DIR>/../../dist/cli.js" --cmd <subcommand> [args]
```

| User invocation | CLI command | Effect |
|---|---|---|
| `/speak on` | `--cmd on` | Activate voice for this session (required — off by default) |
| `/speak off` | `--cmd off` | Turn voice off for this session |
| `/speak mute` | `--cmd mute` | Alias for `off` |
| `/speak unmute` | `--cmd unmute` | Alias for `on` |
| `/speak provider openai` | `--cmd provider openai` | Switch active TTS provider (persistent) |
| `/speak provider elevenlabs` | `--cmd provider elevenlabs` | Switch active TTS provider (persistent) |
| `/speak voice Marin` | `--cmd voice Marin` | Change voice (persistent) |
| `/speak voices` | `--cmd voices` | List available voices for current provider |
| `/speak speed 1.2` | `--cmd speed 1.2` | Change speed (persistent, range 0.25-4.0) |
| `/speak status` | `--cmd status` | Show current state |
| `/speak test` | `--cmd test` | Speak a diagnostic phrase |

**Routing rule:** If the argument matches one of the subcommand keywords above (`on`, `off`, `mute`, `unmute`, `provider`, `voice`, `voices`, `speed`, `status`, `test`), use `--cmd`. Otherwise, treat the argument as speech content and use `--say`.

## Voice is off by default

Voice output is inactive in every new session until the user runs `/speak on`.
The SessionStart context tells you which state you are in. While voice is off,
do not use active voice and do not shape your final messages for the ear —
nothing will be audible.

## Summarizing long messages for speech

When your final message will contain a table, a code block, or otherwise run
long, speak a short spoken version yourself using active voice as your **last
action before finishing the turn**. The visual message stays complete and
detailed; the spoken one carries only the outcome.

Do this because a table read aloud becomes a stream of label-value pairs that
is almost impossible to follow. You have the full context of the turn, so your
own two-sentence summary is better than anything the fallback can produce.

If you don't, the plugin condenses the message automatically — an LLM rewrite,
falling back to deterministic text surgery. That safety net works, but it is
guessing at what mattered. You aren't.

"As your last action" matters: speaking early in a long turn is fine for
urgency, but a summary should sit adjacent to the message it summarizes.

## Interrupting narration

The user can silence in-flight narration at any time by typing `!shutup`, and
audio also stops automatically whenever they submit a prompt. If narration
stops early, that was intentional — do not re-speak it.

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
- **Anything the end-of-turn hook will cover** — if you're about to finish your turn, don't repeat a short message that the hook will already speak verbatim. (Exception: long, tabular, or code-heavy final messages — see "Summarizing long messages for speech" above. There, your active-voice summary replaces the hook's speech instead of duplicating it, since speaking marks the turn as already spoken.)

## Writing for the ear

- Keep it under 2-3 sentences
- Use natural speech patterns, not written prose
- Front-load the important information
- Avoid technical jargon unless the user will understand it in context
- No markdown formatting — the sanitizer strips it, but write clean text from the start
