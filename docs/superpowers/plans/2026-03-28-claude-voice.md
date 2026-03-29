# claude-speak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that provides voice output via passive hooks (Stop/Notification) and an active voice skill, using a shared sanitizer → TTS → player pipeline.

**Architecture:** Modular pipeline with six core modules (extractor, sanitizer, TTS client, player, config loader, lock manager) wired together by a CLI entry point. Two trigger paths (hook-driven passive, skill-driven active) converge into the same pipeline. Distributed as a Claude Code plugin with hooks, a skill, and behavioral CLAUDE.md.

**Tech Stack:** TypeScript, Node.js, vitest (testing), OpenAI TTS API (gpt-4o-mini-tts-2025-12-15), afplay/aplay (audio playback)

---

## File Structure

```
claude-speak/
├── .claude-plugin/
│   └── plugin.json               # Plugin manifest with userConfig for API key
├── skills/
│   └── voice/
│       └── SKILL.md              # Active voice skill definition
├── hooks/
│   └── hooks.json                # Stop + Notification + SessionStart hooks
├── src/
│   ├── cli.ts                    # Entry point: --trigger / --say, wires pipeline
│   ├── extractor.ts              # Parses hook JSON stdin → assistant message text
│   ├── sanitizer.ts              # Strips markdown formatting for speech
│   ├── tts/
│   │   ├── interface.ts          # TTSProvider interface + TTSOptions type
│   │   └── openai.ts             # gpt-4o-mini-tts implementation
│   ├── player.ts                 # Platform-aware audio playback (afplay/aplay)
│   ├── config.ts                 # Loads ~/.claude-speak.json + env vars, merges with defaults
│   ├── lock.ts                   # Timestamp lockfile read/write for active/passive dedup
│   └── error.ts                  # Beep + log error handler
├── test/
│   ├── extractor.test.ts
│   ├── sanitizer.test.ts
│   ├── tts-openai.test.ts
│   ├── player.test.ts
│   ├── config.test.ts
│   ├── lock.test.ts
│   ├── error.test.ts
│   └── cli.test.ts
├── dist/                         # Compiled JS (gitignored, built before publish)
├── package.json
├── tsconfig.json
├── .gitignore
├── settings.json                 # Default plugin settings
├── CLAUDE.md                     # Behavioral guidance for active voice
├── claude-speak.example.json     # Example user config
├── LICENSE
└── README.md
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.claude-plugin/plugin.json`
- Create: `hooks/hooks.json`
- Create: `settings.json`
- Create: `claude-speak.example.json`
- Create: `LICENSE`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-speak",
  "version": "0.1.0",
  "description": "Voice output layer for Claude Code — passive spoken summaries and active voice capability",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  },
  "dependencies": {
    "openai": "^4.80.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
.superpowers/
*.log
.env
.env.local
```

- [ ] **Step 4: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "claude-speak",
  "version": "0.1.0",
  "description": "Voice output layer for Claude Code — passive spoken summaries and active voice capability",
  "author": {
    "name": "pchouinard"
  },
  "license": "MIT",
  "keywords": ["voice", "tts", "accessibility", "audio"],
  "userConfig": {
    "openai_api_key": {
      "description": "OpenAI API key for TTS (gpt-4o-mini-tts)",
      "sensitive": true
    }
  }
}
```

- [ ] **Step 5: Create `hooks/hooks.json`**

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" --trigger stop"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" --trigger notification"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "diff -q \"${CLAUDE_PLUGIN_ROOT}/package.json\" \"${CLAUDE_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CLAUDE_PLUGIN_DATA}\" && cp \"${CLAUDE_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CLAUDE_PLUGIN_DATA}/package.json\""
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Create `settings.json`**

```json
{}
```

- [ ] **Step 7: Create `claude-speak.example.json`**

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini-tts-2025-12-15",
  "voice": "ash",
  "instructions": "",
  "hooks": {
    "stop": true,
    "notification": true
  },
  "playback": {
    "command": "afplay"
  },
  "cooldown": 15,
  "timeout": 30,
  "logFile": "~/.claude-speak/logs/voice.log"
}
```

- [ ] **Step 8: Create `LICENSE`**

Create an MIT license file with copyright holder `pchouinard` and year `2026`.

- [ ] **Step 9: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 10: Verify TypeScript compiles (empty project)**

Create a minimal `src/cli.ts`:
```typescript
// Entry point — will be implemented in Task 9
export {};
```

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 11: Verify vitest runs (no tests yet)**

Run: `npx vitest run`
Expected: "No test files found" or similar, exits cleanly.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold claude-speak plugin project structure"
```

---

### Task 2: Config Loader

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`

- [ ] **Step 1: Write failing tests for config loader**

```typescript
// test/config.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, type VoiceConfig } from '../src/config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:fs');

describe('loadConfig', () => {
  const mockHome = '/mock/home';

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns defaults when no config file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const config = loadConfig();
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-4o-mini-tts-2025-12-15');
    expect(config.voice).toBe('ash');
    expect(config.enabled).toBe(false); // no config file = disabled
  });

  it('loads and merges config file with defaults', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      voice: 'nova',
      instructions: 'Be sassy',
    }));
    const config = loadConfig();
    expect(config.voice).toBe('nova');
    expect(config.instructions).toBe('Be sassy');
    expect(config.provider).toBe('openai'); // default preserved
    expect(config.enabled).toBe(true); // config exists = enabled
  });

  it('respects CLAUDE_SPEAK_ENABLED=false env override', () => {
    vi.stubEnv('CLAUDE_SPEAK_ENABLED', 'false');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
    const config = loadConfig();
    expect(config.enabled).toBe(false);
  });

  it('reads API key from CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY', () => {
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY', 'sk-test-key');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
    const config = loadConfig();
    expect(config.apiKey).toBe('sk-test-key');
  });

  it('returns null apiKey when env var is not set', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
    const config = loadConfig();
    expect(config.apiKey).toBeNull();
  });

  it('handles malformed config file gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');
    const config = loadConfig();
    expect(config.enabled).toBe(false);
    expect(config.error).toBe('malformed-config');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `loadConfig` does not exist.

- [ ] **Step 3: Implement config loader**

```typescript
// src/config.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface VoiceConfig {
  enabled: boolean;
  provider: string;
  model: string;
  voice: string;
  instructions: string;
  apiKey: string | null;
  hooks: {
    stop: boolean;
    notification: boolean;
  };
  playback: {
    command: string;
  };
  cooldown: number;
  timeout: number;
  logFile: string;
  error?: 'malformed-config';
}

const DEFAULTS: Omit<VoiceConfig, 'enabled' | 'apiKey' | 'error'> = {
  provider: 'openai',
  model: 'gpt-4o-mini-tts-2025-12-15',
  voice: 'ash',
  instructions: '',
  hooks: { stop: true, notification: true },
  playback: { command: detectPlaybackCommand() },
  cooldown: 15,
  timeout: 30,
  logFile: path.join(os.homedir(), '.claude-speak', 'logs', 'voice.log'),
};

function detectPlaybackCommand(): string {
  return process.platform === 'darwin' ? 'afplay' : 'paplay';
}

export function loadConfig(): VoiceConfig {
  const configPath = path.join(os.homedir(), '.claude-speak.json');
  const envEnabled = process.env.CLAUDE_SPEAK_ENABLED;
  const apiKey = process.env.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY ?? null;

  if (!fs.existsSync(configPath)) {
    return {
      ...DEFAULTS,
      enabled: false,
      apiKey,
    };
  }

  let fileConfig: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(raw);
  } catch {
    return {
      ...DEFAULTS,
      enabled: false,
      apiKey,
      error: 'malformed-config',
    };
  }

  const merged: VoiceConfig = {
    provider: (fileConfig.provider as string) ?? DEFAULTS.provider,
    model: (fileConfig.model as string) ?? DEFAULTS.model,
    voice: (fileConfig.voice as string) ?? DEFAULTS.voice,
    instructions: (fileConfig.instructions as string) ?? DEFAULTS.instructions,
    hooks: {
      stop: (fileConfig.hooks as Record<string, boolean>)?.stop ?? DEFAULTS.hooks.stop,
      notification: (fileConfig.hooks as Record<string, boolean>)?.notification ?? DEFAULTS.hooks.notification,
    },
    playback: {
      command: (fileConfig.playback as Record<string, string>)?.command ?? DEFAULTS.playback.command,
    },
    cooldown: (fileConfig.cooldown as number) ?? DEFAULTS.cooldown,
    timeout: (fileConfig.timeout as number) ?? DEFAULTS.timeout,
    logFile: (fileConfig.logFile as string) ?? DEFAULTS.logFile,
    enabled: envEnabled !== undefined ? envEnabled === 'true' : true,
    apiKey,
  };

  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add config loader with env var + file merging"
```

---

### Task 3: Sanitizer

**Files:**
- Create: `src/sanitizer.ts`
- Create: `test/sanitizer.test.ts`

- [ ] **Step 1: Write failing tests for sanitizer**

```typescript
// test/sanitizer.test.ts
import { describe, it, expect } from 'vitest';
import { sanitize } from '../src/sanitizer.js';

describe('sanitize', () => {
  it('strips markdown headers', () => {
    expect(sanitize('## Hello World')).toBe('Hello World');
    expect(sanitize('### Sub heading')).toBe('Sub heading');
  });

  it('strips bold and italic markers', () => {
    expect(sanitize('This is **bold** and *italic*')).toBe('This is bold and italic');
    expect(sanitize('Also __bold__ and _italic_')).toBe('Also bold and italic');
  });

  it('strips code fences', () => {
    const input = 'Before\n```typescript\nconst x = 1;\n```\nAfter';
    expect(sanitize(input)).toBe('Before\nconst x = 1;\nAfter');
  });

  it('strips inline code backticks', () => {
    expect(sanitize('Use the `loadConfig` function')).toBe('Use the loadConfig function');
  });

  it('strips link syntax, keeps display text', () => {
    expect(sanitize('Check [the docs](https://example.com) here')).toBe('Check the docs here');
  });

  it('strips horizontal rules', () => {
    expect(sanitize('Above\n---\nBelow')).toBe('Above\nBelow');
  });

  it('strips bullet markers', () => {
    expect(sanitize('- First item\n- Second item')).toBe('First item\nSecond item');
    expect(sanitize('* First item\n* Second item')).toBe('First item\nSecond item');
  });

  it('strips numbered list prefixes', () => {
    expect(sanitize('1. First\n2. Second\n3. Third')).toBe('First\nSecond\nThird');
  });

  it('strips HTML tags', () => {
    expect(sanitize('Hello <b>world</b>')).toBe('Hello world');
  });

  it('converts markdown tables to natural speech', () => {
    const input = '| File | Status | Notes |\n| --- | --- | --- |\n| app.ts | updated | added error handling |\n| lib.ts | created | new utility |';
    const result = sanitize(input);
    expect(result).toContain('File: app.ts, Status: updated, Notes: added error handling');
    expect(result).toContain('File: lib.ts, Status: created, Notes: new utility');
  });

  it('preserves plain text unchanged', () => {
    expect(sanitize('Just a normal sentence.')).toBe('Just a normal sentence.');
  });

  it('handles empty string', () => {
    expect(sanitize('')).toBe('');
  });

  it('strips multiple formatting types in one pass', () => {
    const input = '## **Bold heading**\n\nSome `code` and [a link](http://x.com).\n\n---';
    const result = sanitize(input);
    expect(result).toBe('Bold heading\n\nSome code and a link.\n');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sanitizer.test.ts`
Expected: FAIL — `sanitize` does not exist.

- [ ] **Step 3: Implement sanitizer**

```typescript
// src/sanitizer.ts

export function sanitize(text: string): string {
  if (!text) return '';

  let result = text;

  // Convert tables before stripping other markdown
  result = convertTables(result);

  // Strip code fences (``` blocks)
  result = result.replace(/```[\w]*\n?/g, '');

  // Strip inline code backticks
  result = result.replace(/`([^`]+)`/g, '$1');

  // Strip markdown headers
  result = result.replace(/^#{1,6}\s+/gm, '');

  // Strip bold/italic markers
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');

  // Strip link syntax, keep display text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Strip horizontal rules
  result = result.replace(/^---+$/gm, '');

  // Strip bullet markers
  result = result.replace(/^[\s]*[-*]\s+/gm, '');

  // Strip numbered list prefixes
  result = result.replace(/^[\s]*\d+\.\s+/gm, '');

  // Strip HTML tags
  result = result.replace(/<[^>]+>/g, '');

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

function convertTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect table: line has pipes and next line is a separator row
    if (line.includes('|') && i + 1 < lines.length && /^\|?\s*[-:]+\s*\|/.test(lines[i + 1])) {
      const headers = parsePipeRow(line);
      i += 2; // skip header + separator

      while (i < lines.length && lines[i].includes('|') && !/^\|?\s*[-:]+\s*\|/.test(lines[i])) {
        const values = parsePipeRow(lines[i]);
        const parts = headers.map((h, idx) => `${h}: ${values[idx] ?? ''}`);
        result.push(parts.join(', '));
        i++;
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

function parsePipeRow(row: string): string[] {
  return row
    .split('|')
    .map(cell => cell.trim())
    .filter(cell => cell.length > 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sanitizer.test.ts`
Expected: All 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sanitizer.ts test/sanitizer.test.ts
git commit -m "feat: add markdown sanitizer for speech-ready text"
```

---

### Task 4: TTS Provider Interface and OpenAI Implementation

**Files:**
- Create: `src/tts/interface.ts`
- Create: `src/tts/openai.ts`
- Create: `test/tts-openai.test.ts`

- [ ] **Step 1: Create TTS provider interface**

```typescript
// src/tts/interface.ts

export interface TTSOptions {
  voice: string;
  model: string;
  instructions?: string;
}

export interface TTSProvider {
  synthesize(text: string, options: TTSOptions): Promise<Buffer>;
}
```

- [ ] **Step 2: Write failing tests for OpenAI TTS provider**

```typescript
// test/tts-openai.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAITTSProvider } from '../src/tts/openai.js';

// Mock the openai module
vi.mock('openai', () => {
  const mockCreate = vi.fn();
  return {
    default: class {
      audio = { speech: { create: mockCreate } };
    },
    __mockCreate: mockCreate,
  };
});

describe('OpenAITTSProvider', () => {
  let provider: OpenAITTSProvider;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('openai');
    mockCreate = (mod as unknown as { __mockCreate: ReturnType<typeof vi.fn> }).__mockCreate;
    mockCreate.mockReset();
    provider = new OpenAITTSProvider('sk-test-key');
  });

  it('calls OpenAI API with correct parameters', async () => {
    const fakeAudio = Buffer.from('fake-audio-data');
    mockCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(fakeAudio.buffer),
    });

    await provider.synthesize('Hello world', {
      voice: 'ash',
      model: 'gpt-4o-mini-tts-2025-12-15',
      instructions: 'Be concise',
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'ash',
      input: 'Hello world',
      instructions: 'Be concise',
    });
  });

  it('returns audio buffer from API response', async () => {
    const fakeAudio = Buffer.from('fake-audio-data');
    mockCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(fakeAudio.buffer),
    });

    const result = await provider.synthesize('Hello', {
      voice: 'ash',
      model: 'gpt-4o-mini-tts-2025-12-15',
    });

    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it('omits instructions when not provided', async () => {
    mockCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(Buffer.from('audio').buffer),
    });

    await provider.synthesize('Hello', {
      voice: 'ash',
      model: 'gpt-4o-mini-tts-2025-12-15',
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'ash',
      input: 'Hello',
    });
  });

  it('propagates API errors', async () => {
    mockCreate.mockRejectedValue(new Error('API rate limit exceeded'));

    await expect(
      provider.synthesize('Hello', { voice: 'ash', model: 'gpt-4o-mini-tts-2025-12-15' })
    ).rejects.toThrow('API rate limit exceeded');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/tts-openai.test.ts`
Expected: FAIL — `OpenAITTSProvider` does not exist.

- [ ] **Step 4: Implement OpenAI TTS provider**

```typescript
// src/tts/openai.ts
import OpenAI from 'openai';
import type { TTSProvider, TTSOptions } from './interface.js';

export class OpenAITTSProvider implements TTSProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async synthesize(text: string, options: TTSOptions): Promise<Buffer> {
    const params: Record<string, unknown> = {
      model: options.model,
      voice: options.voice,
      input: text,
    };

    if (options.instructions) {
      params.instructions = options.instructions;
    }

    const response = await this.client.audio.speech.create(params as Parameters<typeof this.client.audio.speech.create>[0]);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/tts-openai.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tts/interface.ts src/tts/openai.ts test/tts-openai.test.ts
git commit -m "feat: add TTS provider interface and OpenAI implementation"
```

---

### Task 5: Player

**Files:**
- Create: `src/player.ts`
- Create: `test/player.test.ts`

- [ ] **Step 1: Write failing tests for player**

```typescript
// test/player.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playAudio } from '../src/player.js';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process');
vi.mock('node:fs');

describe('playAudio', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/claude-speak-abc');
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(child_process.spawn).mockReturnValue({
      unref: vi.fn(),
      on: vi.fn(),
    } as unknown as child_process.ChildProcess);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes audio buffer to a temp file', () => {
    const audio = Buffer.from('audio-data');
    playAudio(audio, 'afplay');

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('claude-speak'),
      audio
    );
  });

  it('spawns the playback command with the temp file', () => {
    const audio = Buffer.from('audio-data');
    playAudio(audio, 'afplay');

    expect(child_process.spawn).toHaveBeenCalledWith(
      'afplay',
      [expect.stringContaining('claude-speak')],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
  });

  it('unrefs the child process so Node can exit', () => {
    const mockUnref = vi.fn();
    vi.mocked(child_process.spawn).mockReturnValue({
      unref: mockUnref,
      on: vi.fn(),
    } as unknown as child_process.ChildProcess);

    playAudio(Buffer.from('audio'), 'afplay');
    expect(mockUnref).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/player.test.ts`
Expected: FAIL — `playAudio` does not exist.

- [ ] **Step 3: Implement player**

```typescript
// src/player.ts
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function playAudio(audio: Buffer, command: string): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-speak-'));
  const filePath = path.join(tmpDir, 'output.mp3');
  fs.writeFileSync(filePath, audio);

  const child = spawn(command, [filePath], {
    detached: true,
    stdio: 'ignore',
  });

  // Clean up temp file after playback finishes
  child.on('exit', () => {
    try {
      fs.unlinkSync(filePath);
      fs.rmdirSync(tmpDir);
    } catch {
      // best effort cleanup
    }
  });

  child.unref();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/player.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/player.ts test/player.test.ts
git commit -m "feat: add platform-aware audio player with temp file management"
```

---

### Task 6: Lock Manager

**Files:**
- Create: `src/lock.ts`
- Create: `test/lock.test.ts`

- [ ] **Step 1: Write failing tests for lock manager**

```typescript
// test/lock.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeLock, isLocked } from '../src/lock.js';
import * as fs from 'node:fs';

vi.mock('node:fs');

describe('lock manager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('writeLock', () => {
    it('writes current timestamp to lockfile', () => {
      const now = 1711648000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      writeLock('/tmp/voice.lock');

      expect(fs.writeFileSync).toHaveBeenCalledWith('/tmp/voice.lock', String(now));
    });

    it('creates parent directory if needed', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      writeLock('/tmp/subdir/voice.lock');

      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/subdir', { recursive: true });
    });
  });

  describe('isLocked', () => {
    it('returns false when lockfile does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(isLocked('/tmp/voice.lock', 15)).toBe(false);
    });

    it('returns true when lock is within cooldown window', () => {
      const now = 1711648000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Lock was written 5 seconds ago
      vi.mocked(fs.readFileSync).mockReturnValue(String(now - 5000));

      expect(isLocked('/tmp/voice.lock', 15)).toBe(true);
    });

    it('returns false when lock is outside cooldown window', () => {
      const now = 1711648000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Lock was written 20 seconds ago
      vi.mocked(fs.readFileSync).mockReturnValue(String(now - 20000));

      expect(isLocked('/tmp/voice.lock', 15)).toBe(false);
    });

    it('returns false when lockfile content is invalid', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not-a-number');

      expect(isLocked('/tmp/voice.lock', 15)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lock.test.ts`
Expected: FAIL — `writeLock` and `isLocked` do not exist.

- [ ] **Step 3: Implement lock manager**

```typescript
// src/lock.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export function writeLock(lockPath: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, String(Date.now()));
}

export function isLocked(lockPath: string, cooldownSeconds: number): boolean {
  if (!fs.existsSync(lockPath)) return false;

  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const timestamp = Number(raw);
    if (Number.isNaN(timestamp)) return false;

    const elapsed = Date.now() - timestamp;
    return elapsed < cooldownSeconds * 1000;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lock.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lock.ts test/lock.test.ts
git commit -m "feat: add timestamp lockfile for active/passive voice dedup"
```

---

### Task 7: Error Handler

**Files:**
- Create: `src/error.ts`
- Create: `test/error.test.ts`

- [ ] **Step 1: Write failing tests for error handler**

```typescript
// test/error.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleError } from '../src/error.js';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';

vi.mock('node:child_process');
vi.mock('node:fs');

describe('handleError', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.appendFileSync).mockReturnValue(undefined);
    vi.mocked(child_process.spawnSync).mockReturnValue({
      status: 0,
    } as child_process.SpawnSyncReturns<string>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs error to file with timestamp', () => {
    const now = new Date('2026-03-28T12:00:00Z');
    vi.spyOn(global, 'Date').mockImplementation(() => now);

    handleError(new Error('API timeout'), '/tmp/voice.log');

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/voice.log',
      expect.stringContaining('API timeout')
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      '/tmp/voice.log',
      expect.stringContaining('2026')
    );
  });

  it('creates log directory if needed', () => {
    handleError(new Error('test'), '/tmp/logs/voice.log');

    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/logs', { recursive: true });
  });

  it('plays system beep on macOS', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    handleError(new Error('test'), '/tmp/voice.log');

    expect(child_process.spawnSync).toHaveBeenCalledWith(
      'afplay',
      ['/System/Library/Sounds/Basso.aiff']
    );

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('does not throw even if logging fails', () => {
    vi.mocked(fs.appendFileSync).mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => handleError(new Error('test'), '/tmp/voice.log')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/error.test.ts`
Expected: FAIL — `handleError` does not exist.

- [ ] **Step 3: Implement error handler**

```typescript
// src/error.ts
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function handleError(error: unknown, logFile: string): void {
  try {
    // Log to file
    const message = error instanceof Error ? error.message : String(error);
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ERROR: ${message}\n`;

    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, logEntry);
  } catch {
    // If logging fails, we still try the beep
  }

  try {
    // Play system beep
    if (process.platform === 'darwin') {
      spawnSync('afplay', ['/System/Library/Sounds/Basso.aiff']);
    } else {
      spawnSync('paplay', ['/usr/share/sounds/freedesktop/stereo/dialog-error.oga']);
    }
  } catch {
    // If beep fails, nothing more we can do
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/error.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/error.ts test/error.test.ts
git commit -m "feat: add error handler with beep notification and log file"
```

---

### Task 8: Extractor

**Files:**
- Create: `src/extractor.ts`
- Create: `test/extractor.test.ts`

- [ ] **Step 1: Write failing tests for extractor**

Note: The exact shape of the hook JSON stdin depends on what Claude Code sends to `Stop` and `Notification` hooks. Based on the Claude Code hooks documentation, the hook receives a JSON object on stdin. We need to extract the assistant's last message from it. The structure will include a `stop_reason` and the last assistant message content. We'll design the extractor to handle the expected format and fail gracefully for unexpected shapes.

```typescript
// test/extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractMessage } from '../src/extractor.js';

describe('extractMessage', () => {
  it('extracts assistant message from Stop hook JSON', () => {
    const hookData = {
      stop_reason: 'end_turn',
      message: {
        role: 'assistant',
        content: 'I updated the config file and ran the tests. All 12 tests pass.',
      },
    };
    const result = extractMessage(JSON.stringify(hookData));
    expect(result).toBe('I updated the config file and ran the tests. All 12 tests pass.');
  });

  it('extracts message from Notification hook JSON', () => {
    const hookData = {
      message: {
        role: 'assistant',
        content: 'I need your permission to delete the old migration files.',
      },
    };
    const result = extractMessage(JSON.stringify(hookData));
    expect(result).toBe('I need your permission to delete the old migration files.');
  });

  it('returns null for malformed JSON', () => {
    expect(extractMessage('not valid json{{{')).toBeNull();
  });

  it('returns null when no message content is present', () => {
    const hookData = { stop_reason: 'end_turn' };
    expect(extractMessage(JSON.stringify(hookData))).toBeNull();
  });

  it('returns null for empty message content', () => {
    const hookData = {
      message: { role: 'assistant', content: '' },
    };
    expect(extractMessage(JSON.stringify(hookData))).toBeNull();
  });

  it('handles message content as string directly', () => {
    const hookData = {
      message: 'Simple string message',
    };
    const result = extractMessage(JSON.stringify(hookData));
    expect(result).toBe('Simple string message');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/extractor.test.ts`
Expected: FAIL — `extractMessage` does not exist.

- [ ] **Step 3: Implement extractor**

```typescript
// src/extractor.ts

export function extractMessage(input: string): string | null {
  try {
    const data = JSON.parse(input);

    // Handle message as an object with content field
    if (data?.message?.content && typeof data.message.content === 'string') {
      return data.message.content || null;
    }

    // Handle message as a direct string
    if (typeof data?.message === 'string' && data.message.length > 0) {
      return data.message;
    }

    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/extractor.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extractor.ts test/extractor.test.ts
git commit -m "feat: add hook JSON extractor for assistant messages"
```

---

### Task 9: CLI Entry Point

**Files:**
- Modify: `src/cli.ts`
- Create: `test/cli.test.ts`

- [ ] **Step 1: Write failing tests for CLI**

```typescript
// test/cli.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { run } from '../src/cli.js';
import * as config from '../src/config.js';
import * as extractor from '../src/extractor.js';
import * as sanitizer from '../src/sanitizer.js';
import * as lock from '../src/lock.js';
import * as player from '../src/player.js';
import * as error from '../src/error.js';

vi.mock('../src/config.js');
vi.mock('../src/extractor.js');
vi.mock('../src/sanitizer.js');
vi.mock('../src/lock.js');
vi.mock('../src/player.js');
vi.mock('../src/error.js');

// Mock the TTS provider
const mockSynthesize = vi.fn();
vi.mock('../src/tts/openai.js', () => ({
  OpenAITTSProvider: class {
    synthesize = mockSynthesize;
  },
}));

function makeConfig(overrides: Partial<config.VoiceConfig> = {}): config.VoiceConfig {
  return {
    enabled: true,
    provider: 'openai',
    model: 'gpt-4o-mini-tts-2025-12-15',
    voice: 'ash',
    instructions: '',
    apiKey: 'sk-test',
    hooks: { stop: true, notification: true },
    playback: { command: 'afplay' },
    cooldown: 15,
    timeout: 30,
    logFile: '/tmp/voice.log',
    ...overrides,
  };
}

describe('CLI run', () => {
  beforeEach(() => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig());
    vi.mocked(sanitizer.sanitize).mockImplementation((t) => t);
    vi.mocked(lock.isLocked).mockReturnValue(false);
    vi.mocked(lock.writeLock).mockReturnValue(undefined);
    vi.mocked(player.playAudio).mockReturnValue(undefined);
    vi.mocked(error.handleError).mockReturnValue(undefined);
    mockSynthesize.mockResolvedValue(Buffer.from('audio'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits immediately when voice is disabled', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({ enabled: false }));
    await run(['--trigger', 'stop'], '');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('processes --say argument through the pipeline', async () => {
    await run(['--say', 'Hello world'], '');

    expect(sanitizer.sanitize).toHaveBeenCalledWith('Hello world');
    expect(mockSynthesize).toHaveBeenCalled();
    expect(player.playAudio).toHaveBeenCalled();
  });

  it('writes lock when using --say (active voice)', async () => {
    await run(['--say', 'Hello'], '');
    expect(lock.writeLock).toHaveBeenCalled();
  });

  it('processes --trigger by extracting from stdin', async () => {
    const stdinData = JSON.stringify({
      message: { role: 'assistant', content: 'Done with the task.' },
    });
    vi.mocked(extractor.extractMessage).mockReturnValue('Done with the task.');

    await run(['--trigger', 'stop'], stdinData);

    expect(extractor.extractMessage).toHaveBeenCalledWith(stdinData);
    expect(sanitizer.sanitize).toHaveBeenCalledWith('Done with the task.');
    expect(mockSynthesize).toHaveBeenCalled();
  });

  it('skips passive voice when lock is active', async () => {
    vi.mocked(lock.isLocked).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('Some message');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('skips when hook type is disabled in config', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({
      hooks: { stop: false, notification: true },
    }));
    vi.mocked(extractor.extractMessage).mockReturnValue('Some message');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('calls error handler on TTS failure', async () => {
    mockSynthesize.mockRejectedValue(new Error('API down'));

    await run(['--say', 'Hello'], '');

    expect(error.handleError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.any(String)
    );
  });

  it('exits when no API key is configured', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({ apiKey: null }));

    await run(['--say', 'Hello'], '');

    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(error.handleError).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `run` does not exist or is an empty export.

- [ ] **Step 3: Implement CLI entry point**

```typescript
// src/cli.ts
import { loadConfig } from './config.js';
import { extractMessage } from './extractor.js';
import { sanitize } from './sanitizer.js';
import { OpenAITTSProvider } from './tts/openai.js';
import { playAudio } from './player.js';
import { writeLock, isLocked } from './lock.js';
import { handleError } from './error.js';
import * as path from 'node:path';

export async function run(args: string[], stdin: string): Promise<void> {
  const config = loadConfig();

  if (!config.enabled) return;

  const sayIndex = args.indexOf('--say');
  const triggerIndex = args.indexOf('--trigger');

  let text: string | null = null;
  let isActiveVoice = false;

  if (sayIndex !== -1 && args[sayIndex + 1]) {
    // Active voice mode
    text = args[sayIndex + 1];
    isActiveVoice = true;
  } else if (triggerIndex !== -1 && args[triggerIndex + 1]) {
    // Passive voice mode
    const triggerType = args[triggerIndex + 1] as 'stop' | 'notification';

    // Check if this hook type is enabled
    if (!config.hooks[triggerType]) return;

    // Check lockfile for active/passive dedup
    const lockPath = getLockPath();
    if (isLocked(lockPath, config.cooldown)) return;

    text = extractMessage(stdin);
  } else {
    return;
  }

  if (!text) return;

  if (!config.apiKey) {
    handleError(new Error('No API key configured. Set OPENAI_API_KEY or configure via plugin settings.'), config.logFile);
    return;
  }

  // Sanitize
  const sanitized = sanitize(text);
  if (!sanitized) return;

  // Write lock if active voice
  if (isActiveVoice) {
    writeLock(getLockPath());
  }

  // TTS
  try {
    const provider = new OpenAITTSProvider(config.apiKey);
    const audio = await provider.synthesize(sanitized, {
      voice: config.voice,
      model: config.model,
      instructions: config.instructions || undefined,
    });

    // Play
    playAudio(audio, config.playback.command);
  } catch (err) {
    handleError(err, config.logFile);
  }
}

function getLockPath(): string {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(process.env.HOME || '', '.claude-speak');
  return path.join(dataDir, 'voice.lock');
}

// Main execution when run as script
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainModule) {
  let stdin = '';
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    stdin = Buffer.concat(chunks).toString('utf-8');
  }
  run(process.argv.slice(2), stdin).catch((err) => {
    console.error('claude-speak fatal:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 5: Run all tests to verify nothing is broken**

Run: `npx vitest run`
Expected: All tests across all files PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: add CLI entry point wiring passive and active voice pipeline"
```

---

### Task 10: Active Voice Skill and CLAUDE.md

**Files:**
- Create: `skills/voice/SKILL.md`
- Create: `CLAUDE.md`

- [ ] **Step 1: Create the active voice skill definition**

```markdown
<!-- skills/voice/SKILL.md -->
---
name: voice
description: Speak to the user audibly through text-to-speech. Use when the user may not be watching the screen and something warrants their audible attention.
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
```

- [ ] **Step 2: Create the behavioral CLAUDE.md**

```markdown
<!-- CLAUDE.md -->
## Voice Output Capability

This Claude Code session has voice output enabled via the claude-speak plugin.

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
```

- [ ] **Step 3: Commit**

```bash
git add skills/voice/SKILL.md CLAUDE.md
git commit -m "feat: add active voice skill definition and CLAUDE.md behavioral guidance"
```

---

### Task 11: Build and Verify

**Files:**
- Modify: `package.json` (if needed)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS across all 8 test files.

- [ ] **Step 2: Build the TypeScript project**

Run: `npx tsc`
Expected: No errors. `dist/` directory created with compiled `.js` files.

- [ ] **Step 3: Verify the compiled CLI can be invoked**

Run: `node dist/cli.js --help 2>&1 || true`
Expected: The process starts and exits cleanly (no crash). Since we don't have a --help flag, it should just exit silently because no valid arguments were passed and voice is not configured.

- [ ] **Step 4: Verify plugin structure is complete**

Confirm these files exist:
- `.claude-plugin/plugin.json`
- `hooks/hooks.json`
- `skills/voice/SKILL.md`
- `CLAUDE.md`
- `dist/cli.js`
- `package.json`

Run: `ls -la .claude-plugin/plugin.json hooks/hooks.json skills/voice/SKILL.md CLAUDE.md dist/cli.js package.json`
Expected: All files listed, no "No such file" errors.

- [ ] **Step 5: Commit build artifacts (dist is needed for the plugin)**

Note: For a plugin, `dist/` must be included because the hooks reference `${CLAUDE_PLUGIN_ROOT}/dist/cli.js`. Remove `dist/` from `.gitignore`.

```bash
# Remove dist/ from .gitignore
# Then:
git add -A
git commit -m "chore: build compiled output and verify plugin structure"
```

---

### Task 12: README and Example Config

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

```markdown
# claude-speak

Voice output layer for Claude Code. Speaks Claude's responses aloud so you can work hands-free.

## Features

- **Passive voice** — Automatically speaks Claude's final message at the end of each turn
- **Active voice** — Claude can choose to speak when something warrants your audible attention
- **Configurable TTS** — Voice, model, delivery instructions, all tunable
- **Provider-agnostic** — Defaults to OpenAI gpt-4o-mini-tts, swappable via interface

## Installation

Install as a Claude Code plugin:

```bash
claude plugin install claude-speak
```

You'll be prompted for your OpenAI API key during installation (stored securely in your system keychain).

## Configuration

Copy the example config and customize:

```bash
cp claude-speak.example.json ~/.claude-speak.json
```

Edit `~/.claude-speak.json` to set your preferred voice, delivery instructions, and hook preferences.

### Quick toggle

```bash
# Disable voice temporarily
export CLAUDE_SPEAK_ENABLED=false

# Re-enable
export CLAUDE_SPEAK_ENABLED=true
```

## How it works

### Passive mode
When Claude finishes a turn, the `Stop` hook captures the last message, strips markdown formatting, sends it to the TTS API, and plays the audio locally.

### Active mode
Claude knows it has a voice (via the bundled skill and CLAUDE.md). It can choose to speak during a turn for critical failures, blocking decisions, or anything you should hear without looking at the screen.

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with installation and usage instructions"
```

---

## Summary

| Task | Description | Tests |
|------|-------------|-------|
| 1 | Project scaffolding | — |
| 2 | Config loader | 6 |
| 3 | Sanitizer | 13 |
| 4 | TTS provider interface + OpenAI | 4 |
| 5 | Player | 3 |
| 6 | Lock manager | 5 |
| 7 | Error handler | 4 |
| 8 | Extractor | 6 |
| 9 | CLI entry point | 8 |
| 10 | Skill + CLAUDE.md | — |
| 11 | Build + verify | — |
| 12 | README | — |
| **Total** | **12 tasks** | **49 tests** |
