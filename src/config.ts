import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isOldFormat, migrateConfig, type ProviderConfig } from './migration.js';

export type { ProviderConfig } from './migration.js';

export interface ApiKeys {
  openai: string | null;
  elevenlabs: string | null;
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

function detectPlaybackCommand(): string {
  return process.platform === 'darwin' ? 'afplay' : 'paplay';
}

function getSharedDefaults() {
  return {
    hooks: { stop: true, notification: true },
    playback: { command: detectPlaybackCommand() },
    cooldown: 15,
    timeout: 30,
    logFile: path.join(os.homedir(), '.claude-speak', 'logs', 'voice.log'),
  };
}

function loadApiKeys(): ApiKeys {
  return {
    openai: process.env.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
    elevenlabs: process.env.CLAUDE_PLUGIN_OPTION_ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_API_KEY ?? null,
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
    cooldown: (fileConfig.cooldown as number) ?? shared.cooldown,
    timeout: (fileConfig.timeout as number) ?? shared.timeout,
    logFile: (fileConfig.logFile as string) ?? shared.logFile,
  };
}
