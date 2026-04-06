# Session Mute & Multi-Provider TTS Design

**Date:** 2026-04-05
**Status:** Draft
**Scope:** Two features for the claude-speak plugin: (1) session mute/unmute, (2) multi-provider support with ElevenLabs as a second TTS backend, plus a subcommand system to control both.

---

## 1. Config Restructure & Auto-Migration

### New config format (`~/.claude-speak.json`)

```json
{
  "activeProvider": "openai",
  "providers": {
    "openai": {
      "model": "gpt-4o-mini-tts-2025-12-15",
      "voice": "Marin",
      "instructions": "Speak in a cheeky, conversational tone.",
      "speed": 1.2
    },
    "elevenlabs": {
      "model": "eleven_multilingual_v2",
      "voice": "Rachel",
      "voiceId": "21m00Tcm4TlvDq8ikWAM",
      "stability": 0.5,
      "similarityBoost": 0.75,
      "style": 0.0,
      "speed": 1.0
    }
  },
  "hooks": {
    "stop": true,
    "notification": true
  },
  "playback": {
    "command": "afplay"
  },
  "cooldown": 10,
  "timeout": 30,
  "logFile": "~/.claude-speak/logs/voice.log"
}
```

Shared settings (hooks, playback, cooldown, timeout, logFile) stay top-level since they are provider-agnostic. Provider-specific settings nest under their name inside the `providers` block. Each provider defines its own defaults for fields not present in the user's config.

### Voice resolution for ElevenLabs

- If `voiceId` is present, use it directly.
- If only `voice` (name) is present, look it up in the local voice cache (`~/.claude-speak/voices-elevenlabs.json`).
- If both are present, `voiceId` wins (the name is for human readability).

### Auto-migration logic

When the config loader detects the old flat format (has `provider` and `voice` at the top level but no `providers` block):

1. Read the old config.
2. Build the new structure: move `provider` to `activeProvider`, nest `model`, `voice`, `instructions`, `speed` under `providers.openai`.
3. Preserve all shared settings as-is.
4. Write the migrated config back to `~/.claude-speak.json`.
5. Log a one-time message: "Config auto-migrated to multi-provider format."

If the write fails (permissions, disk full, etc.), continue with the migrated config in memory and log a warning: "Could not save migrated config. Your settings are loaded but still in the old format on disk."

---

## 2. Provider Architecture

### TTSProvider interface

The existing interface shape is unchanged:

```typescript
interface TTSProvider {
  synthesize(text: string, options: TTSOptions): Promise<Buffer>;
}
```

`TTSOptions` becomes provider-aware but stays a single type. Each provider picks what it needs:

```typescript
interface TTSOptions {
  voice: string;
  voiceId?: string;
  model: string;
  instructions?: string;
  speed?: number;
  // ElevenLabs-specific
  stability?: number;
  similarityBoost?: number;
  style?: number;
}
```

### OpenAITTSProvider

Stays mostly as-is. Already uses `model`, `voice`, `instructions`, `speed`. No structural changes needed.

### ElevenLabsTTSProvider (new)

- Constructor takes API key.
- Uses raw `fetch` against `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`.
- Resolves voice name to ID via cache if `voiceId` not provided.
- Maps options into ElevenLabs request body:
  - `text` from input.
  - `model_id` from `options.model`.
  - `voice_settings`: `{ stability, similarity_boost, style, speed }`.
- Returns MP3 buffer (`mp3_44100_128` output format, compatible with `afplay`/`paplay`).
- No SDK dependency; single POST with `xi-api-key` header.

### Provider factory

A function in a new `tts/factory.ts`:

```typescript
function createProvider(name: string, apiKeys: ApiKeys): TTSProvider
```

Takes the provider name, returns the right instance. Throws a clear error if the API key for the requested provider is missing.

### API key handling

Both keys live in `~/.claude-speak/env`:

```bash
export OPENAI_API_KEY=sk-...
export ELEVENLABS_API_KEY=xi-...
```

The config loader reads:
- `CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY` or `OPENAI_API_KEY` for OpenAI.
- `CLAUDE_PLUGIN_OPTION_ELEVENLABS_API_KEY` or `ELEVENLABS_API_KEY` for ElevenLabs.

Only the active provider's key needs to be present.

---

## 3. Session State & Mute System

### Session override file

`~/.claude-speak/session.json` holds transient overrides that layer on top of the persistent config:

```json
{
  "muted": true
}
```

Only populated fields override. If `session.json` doesn't exist or a field is absent, the persistent config value is used.

### Loading order

```
Defaults -> ~/.claude-speak.json (persistent) -> session.json (transient)
```

The CLI loads persistent config at startup, then checks for `session.json` and overlays any values found. Mute is checked first; if muted, the CLI exits immediately before doing any TTS work.

### Persistence rules

| Setting | Written to | Lifetime |
|---|---|---|
| `mute` / `unmute` | `session.json` | Session (cleaned on start) |
| `speed` | `~/.claude-speak.json` (active provider block) | Persistent |
| `provider` | `~/.claude-speak.json` | Persistent |
| `voice` | `~/.claude-speak.json` (active provider block) | Persistent |

### Session cleanup

The SessionStart hook (`scripts/check-setup.sh`) deletes `~/.claude-speak/session.json` on session start. Every session starts fresh, unmuted.

### Mute check placement

The mute check goes at the very top of the `run()` function in `cli.ts`, before any TTS work, stdin reading, or lock checking. If muted:
- Active voice (`--say`): exit silently, don't write a lock.
- Passive voice (`--trigger`): exit silently.

No API calls, no audio processing, no file I/O beyond reading the session file.

---

## 4. Subcommand System

### CLI routing

The CLI gains a `--cmd` flag for subcommand dispatch:

```
node cli.js --say "Hello"                    # Active voice (existing)
node cli.js --cmd mute                       # Mute
node cli.js --cmd unmute                     # Unmute
node cli.js --cmd provider elevenlabs        # Switch provider
node cli.js --cmd voice Rachel               # Switch voice
node cli.js --cmd voices                     # List voices
node cli.js --cmd speed 1.5                  # Change speed
node cli.js --cmd status                     # Show current state
node cli.js --cmd test                       # Speak diagnostic phrase
```

### Skill routing

The `speak` skill stays as a single entry point. SKILL.md documents all subcommands and instructs Claude on routing. When the user says `/speak: mute`, Claude reads the skill, recognizes the subcommand keyword, and runs the appropriate `--cmd` call. When the user says `/speak: Something important happened`, Claude recognizes it's not a keyword and runs `--say`.

### Subcommand behaviors

**`mute`** -- Writes `{"muted": true}` to `session.json`. Outputs text confirmation to stdout (no speech).

**`unmute`** -- Removes `muted` from `session.json` (or deletes the file if empty). Speaks a short confirmation via TTS to prove it worked.

**`provider [name]`** -- Validates the provider name is supported (`openai` or `elevenlabs`). Validates the API key for that provider is available. If the provider block doesn't exist in the user's config, creates one with sensible defaults (the user then sets a voice via `/speak: voices` + `/speak: voice`). Updates `activeProvider` in `~/.claude-speak.json`. Outputs confirmation.

**`voice [name]`** -- For OpenAI: validates against known voice list. For ElevenLabs: resolves name via voice cache, falls back to treating as raw voice ID. Updates the active provider's `voice` (and `voiceId` for ElevenLabs) in `~/.claude-speak.json`. Outputs confirmation.

**`voices`** -- For OpenAI: prints the static list (alloy, ash, ballad, cedar, coral, echo, fable, marin, nova, onyx, sage, shimmer, verse). For ElevenLabs: calls `/v1/voices` API, updates `~/.claude-speak/voices-elevenlabs.json` cache, prints list with name, category, and voice ID.

**`speed [value]`** -- Validates range (0.25 to 4.0). Updates the active provider's `speed` in `~/.claude-speak.json`. Outputs confirmation.

**`status`** -- Reads config + session state, outputs summary:
```
Provider: openai
Voice: Marin
Speed: 1.2
Muted: no
Hooks: stop (on) notification (on)
```

**`test`** -- Speaks a diagnostic phrase through the full pipeline: "Voice check. Provider: OpenAI. Voice: Marin. Speed: 1.2." Confirms the entire chain works end to end.

---

## 5. Voice Cache System

### Cache file

`~/.claude-speak/voices-elevenlabs.json`:

```json
{
  "fetched": "2026-04-05T12:00:00Z",
  "voices": [
    {
      "name": "Rachel",
      "voiceId": "21m00Tcm4TlvDq8ikWAM",
      "category": "premade"
    },
    {
      "name": "My Custom Clone",
      "voiceId": "abc123def456",
      "category": "cloned"
    }
  ]
}
```

### When it's populated

Only on explicit `/speak: voices` when ElevenLabs is the active provider. No background fetching, no stale-checking, no auto-refresh. The user controls when the API is called.

### Voice name resolution flow

1. If `voiceId` is set in config, use it directly.
2. If only `voice` (name) is set, read the cache file.
3. Case-insensitive match against `voices[].name`.
4. If found, use the matched `voiceId`.
5. If cache file doesn't exist, error: "Run /speak: voices to fetch your voice list."
6. If name not found in cache, treat the value as a raw voice ID. Let the API call succeed or fail naturally.

### OpenAI voices

No cache needed. Static hardcoded list:

```
alloy, ash, ballad, cedar, coral, echo, fable,
marin, nova, onyx, sage, shimmer, verse
```

### Display format for `/speak: voices`

OpenAI:
```
Available voices (OpenAI):
  alloy, ash, ballad, cedar, coral, echo, fable,
  marin, nova, onyx, sage, shimmer, verse
```

ElevenLabs:
```
Available voices (ElevenLabs) -- fetched just now:
  Rachel        premade    21m00Tcm4TlvDq8ikWAM
  My Clone      cloned     abc123def456
```

---

## 6. Error Handling

### Provider-specific errors

**Missing API key:** `/speak: provider elevenlabs` without `ELEVENLABS_API_KEY` set fails immediately: "ElevenLabs API key not found. Add `export ELEVENLABS_API_KEY=xi-...` to ~/.claude-speak/env". The switch does not happen; config stays unchanged.

**Invalid voice name:** On OpenAI, rejects with "Unknown voice. Run /speak: voices to see available options." On ElevenLabs, checks cache first, then falls through to raw ID. If the API rejects it, error surfaces naturally.

**Voice cache missing:** "No voice cache found. Run /speak: voices to fetch your voice list."

**ElevenLabs API errors:** 401 (bad key), 422 (invalid params), 429 (rate limit) get human-readable messages logged via existing `handleError()` (log to file + system beep). No retry logic.

**Speed out of range:** Rejects with "Speed must be between 0.25 and 4.0." Config unchanged.

### Migration errors

Write failure: continue with migrated config in memory, log warning.

### Session state errors

Corrupted `session.json`: delete it, treat as unmuted, log the event.

### Existing error path

The `handleError()` flow (log to file, play system beep) stays unchanged. Both providers feed into the same handler.

---

## 7. Testing Strategy

### New test files

- **`test/tts-elevenlabs.test.ts`** -- Mock fetch calls. Verify URL construction, request body, headers, buffer conversion, voice name resolution, error handling (401, 422, 429).
- **`test/voice-cache.test.ts`** -- Cache read/write, case-insensitive lookup, missing file, corrupted file.
- **`test/migration.test.ts`** -- Old-to-new format mapping, shared settings preserved, write success/failure, already-migrated passthrough.
- **`test/session.test.ts`** -- Session loading, overlay on persistent config, muted state check, missing file, corrupted file cleanup.
- **`test/subcommands.test.ts`** -- Routing and behavior for all subcommands: mute, unmute, provider, voice, voices, speed, status, test.

### Modified test files

- **`test/config.test.ts`** -- Nested config loading, migration detection, provider defaults, `ELEVENLABS_API_KEY` env var.
- **`test/cli.test.ts`** -- Mute early exit, `--cmd` routing, provider factory dispatch.

### Unchanged test files

`test/sanitizer.test.ts`, `test/extractor.test.ts`, `test/lock.test.ts`, `test/player.test.ts`, `test/error.test.ts` -- provider-agnostic, no modification needed.

---

## 8. File & Module Structure

### New source files

```
src/
  tts/
    interface.ts          # Updated TTSOptions
    openai.ts             # Existing (minor tweaks)
    elevenlabs.ts         # NEW: ElevenLabs provider
    factory.ts            # NEW: createProvider(name, keys) -> TTSProvider
  config.ts               # Updated: nested format, migration, provider defaults
  migration.ts            # NEW: detectOldFormat(), migrate()
  session.ts              # NEW: loadSession(), writeSession(), clearSession()
  voice-cache.ts          # NEW: fetchVoices(), readCache(), resolveName()
  subcommands.ts          # NEW: dispatch(cmd, args) -> handles all --cmd operations
  cli.ts                  # Updated: mute check, --cmd routing, provider factory
  extractor.ts            # Unchanged
  sanitizer.ts            # Unchanged
  lock.ts                 # Unchanged
  player.ts               # Unchanged
  error.ts                # Unchanged
```

### Runtime data files

```
~/.claude-speak/
  session.json              # NEW: transient mute state
  voices-elevenlabs.json    # NEW: voice cache
  voice.lock                # Existing
  plugin-root               # Existing
  plugin-data               # Existing
  env                       # Updated: now holds both API keys
  logs/
    voice.log               # Existing
~/.claude-speak.json        # Updated: new nested format (auto-migrated)
```

### Updated plugin artifacts

- `claude-speak.example.json` -- New nested format with both providers.
- `skills/speak/SKILL.md` -- Subcommand documentation and routing instructions.
- `scripts/check-setup.sh` -- Clean `session.json` on session start.
- `CLAUDE.md` -- Mention subcommands are available.
- `hooks.json` -- Unchanged.

### Module dependency flow

```
cli.ts
  config.ts (loads persistent config)
    migration.ts (auto-migrates if needed)
  session.ts (loads session overrides)
  subcommands.ts (if --cmd flag)
    config.ts (for persistent writes)
    session.ts (for mute writes)
    voice-cache.ts (for voices/voice commands)
  tts/factory.ts (creates provider)
    tts/openai.ts
    tts/elevenlabs.ts
      voice-cache.ts (name -> ID resolution)
  extractor.ts
  sanitizer.ts
  lock.ts
  player.ts
  error.ts
```

No circular dependencies. Each module has a single responsibility. Everything bundles into one `dist/cli.js` via esbuild.
