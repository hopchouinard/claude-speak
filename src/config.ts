import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isOldFormat, migrateConfig, type ProviderConfig } from './migration.js';

export type { ProviderConfig } from './migration.js';

export interface ApiKeys {
  openai: string | null;
  elevenlabs: string | null;
}

export interface SummarizerConfig {
  model: string;
  timeout: number;
  maxWords: number;
}

export interface SpeechConfig {
  maxChars: number;
  condense: boolean;
  summarizer: SummarizerConfig;
}

export interface VoiceConfig {
  enabled: boolean;
  activeProvider: string;
  providers: Record<string, ProviderConfig>;
  apiKeys: ApiKeys;
  hooks: {
    stop: boolean;
    notification: boolean;
  };
  playback: {
    command: string;
  };
  speech: SpeechConfig;
  cooldown: number;
  timeout: number;
  logFile: string;
  error?: 'malformed-config';
}

export const PROVIDER_DEFAULTS: Record<string, ProviderConfig> = {
  openai: {
    model: 'gpt-4o-mini-tts-2025-12-15',
    voice: 'ash',
    speed: 1.0,
  },
  elevenlabs: {
    model: 'eleven_multilingual_v2',
    voice: '',
    speed: 1.0,
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0.0,
  },
};

function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function detectPlaybackCommand(): string {
  return process.platform === 'darwin' ? 'afplay' : 'paplay';
}

/**
 * Config values come from hand-edited JSON, so a field can hold any type.
 * These pick the value only when it is actually the type we need, falling back
 * to the default otherwise.
 *
 * A bare `??` is not enough: `"condense": "false"` is a string, which is not
 * nullish, so `??` would keep it — and a non-empty string is truthy, so
 * condensation would stay on for someone who was trying to turn it off.
 */
function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getSharedDefaults() {
  return {
    // Notification speech is off by default. The Notification hook receives
    // Claude Code's own system strings — away summaries, recaps, permission
    // prompts — which are neither the assistant's words nor visible on screen,
    // so speaking them produces narration the user never asked for and cannot
    // find in the transcript. That is the exact thing this release exists to
    // stop. Set "notification": true to opt back in.
    hooks: { stop: true, notification: false },
    playback: { command: detectPlaybackCommand() },
    speech: {
      maxChars: 500,
      condense: true,
      summarizer: {
        model: 'gpt-5.4-nano-2026-03-17',
        timeout: 8,
        maxWords: 40,
      },
    },
    cooldown: 15,
    timeout: 30,
    logFile: path.join(os.homedir(), '.claude-speak', 'logs', 'voice.log'),
  };
}

/**
 * Read KEY=value pairs out of ~/.claude-speak/env.
 *
 * hooks.json sources this file before invoking the CLI, but the speak skill and
 * anything run by hand do not — so a key kept only in this file reached the
 * passive end-of-turn path and nothing else. Active voice and every speaking
 * subcommand failed with "No API key", silently apart from an error beep.
 * Reading it here fixes every invocation path at once.
 *
 * The file is *parsed*, never executed. A shell sources it elsewhere, but
 * evaluating it here would run arbitrary code on every CLI start.
 */
function readEnvFile(): Record<string, string> {
  const result: Record<string, string> = {};

  let raw: unknown;
  try {
    raw = fs.readFileSync(path.join(os.homedir(), '.claude-speak', 'env'), 'utf-8');
  } catch {
    return result;
  }
  if (typeof raw !== 'string') return result;

  for (const line of raw.split('\n')) {
    // Comments and blank lines cannot match: `#` is not an identifier start.
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, name] = match;
    let value = match[2].trim();

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: stop at whitespace, matching how a shell would treat the
      // assignment, so a trailing comment cannot end up inside the key.
      value = value.split(/\s/)[0];
    }

    if (value.length > 0) result[name] = value;
  }

  return result;
}

function loadApiKeys(): ApiKeys {
  const fileEnv = readEnvFile();

  // Process environment wins over the file: an explicitly exported key should
  // override whatever was written to disk earlier.
  const pick = (name: string): string | null =>
    process.env[`CLAUDE_PLUGIN_OPTION_${name}`] ?? process.env[name] ?? fileEnv[name] ?? null;

  return {
    openai: pick('OPENAI_API_KEY'),
    elevenlabs: pick('ELEVENLABS_API_KEY'),
  };
}

export function getConfigPath(): string {
  return path.join(os.homedir(), '.claude-speak.json');
}

export function loadConfig(): VoiceConfig {
  const shared = getSharedDefaults();
  const apiKeys = loadApiKeys();
  const configPath = getConfigPath();
  const envEnabled = process.env.CLAUDE_SPEAK_ENABLED;

  const defaultConfig: VoiceConfig = {
    enabled: false,
    activeProvider: 'openai',
    providers: {
      openai: { ...PROVIDER_DEFAULTS.openai },
      elevenlabs: { ...PROVIDER_DEFAULTS.elevenlabs },
    },
    apiKeys,
    ...shared,
  };

  if (!fs.existsSync(configPath)) {
    return defaultConfig;
  }

  let fileConfig: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(raw);
  } catch {
    return {
      ...defaultConfig,
      error: 'malformed-config',
    };
  }

  // Auto-migrate old flat format
  if (isOldFormat(fileConfig)) {
    const migrated = migrateConfig(fileConfig);
    try {
      fs.writeFileSync(configPath, JSON.stringify(migrated, null, 2), 'utf-8');
    } catch {
      // Continue in memory if write fails
    }
    fileConfig = migrated as unknown as Record<string, unknown>;
  }

  // Parse new nested format
  const activeProvider = (fileConfig.activeProvider as string) ?? 'openai';
  const rawProviders = (fileConfig.providers as Record<string, Record<string, unknown>>) ?? {};

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, rawConfig] of Object.entries(rawProviders)) {
    const defaults = PROVIDER_DEFAULTS[name] ?? { model: '', voice: '', speed: 1.0 };
    providers[name] = { ...defaults, ...rawConfig } as ProviderConfig;
  }

  // Ensure the active provider exists in the map
  if (!providers[activeProvider]) {
    const defaults = PROVIDER_DEFAULTS[activeProvider] ?? { model: '', voice: '', speed: 1.0 };
    providers[activeProvider] = { ...defaults };
  }

  const enabled = envEnabled !== undefined ? envEnabled === 'true' : true;

  const rawSpeech = asRecord(fileConfig.speech);
  const rawSummarizer = asRecord(rawSpeech.summarizer);
  const speech: SpeechConfig = {
    maxChars: pickNumber(rawSpeech.maxChars, shared.speech.maxChars),
    condense: pickBoolean(rawSpeech.condense, shared.speech.condense),
    summarizer: {
      model: pickString(rawSummarizer.model, shared.speech.summarizer.model),
      timeout: pickNumber(rawSummarizer.timeout, shared.speech.summarizer.timeout),
      maxWords: pickNumber(rawSummarizer.maxWords, shared.speech.summarizer.maxWords),
    },
  };

  return {
    enabled,
    activeProvider,
    providers,
    apiKeys,
    hooks: {
      stop: (fileConfig.hooks as Record<string, boolean>)?.stop ?? shared.hooks.stop,
      notification: (fileConfig.hooks as Record<string, boolean>)?.notification ?? shared.hooks.notification,
    },
    playback: {
      command: (fileConfig.playback as Record<string, string>)?.command ?? shared.playback.command,
    },
    speech,
    cooldown: (fileConfig.cooldown as number) ?? shared.cooldown,
    timeout: (fileConfig.timeout as number) ?? shared.timeout,
    logFile: expandTilde((fileConfig.logFile as string) ?? shared.logFile),
  };
}
