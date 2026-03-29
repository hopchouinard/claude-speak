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

function getDefaults(): Omit<VoiceConfig, 'enabled' | 'apiKey' | 'error'> {
  return {
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
}

function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function detectPlaybackCommand(): string {
  return process.platform === 'darwin' ? 'afplay' : 'paplay';
}

export function loadConfig(): VoiceConfig {
  const DEFAULTS = getDefaults();
  const configPath = path.join(os.homedir(), '.claude-speak.json');
  const envEnabled = process.env.CLAUDE_SPEAK_ENABLED;
  const apiKey = process.env.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? null;

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
    logFile: expandTilde((fileConfig.logFile as string) ?? DEFAULTS.logFile),
    enabled: envEnabled !== undefined ? envEnabled === 'true' : true,
    apiKey,
  };

  return merged;
}
