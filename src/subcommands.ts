import * as fs from 'node:fs';
import { loadConfig, getConfigPath, PROVIDER_DEFAULTS } from './config.js';
import { activate, deactivate, isActive, setSpokeThisTurn, gcSessions } from './session.js';
import { stopPlayback } from './player.js';
import { readCache, fetchElevenLabsVoices, writeCache, resolveVoiceName } from './voice-cache.js';

export interface SubcommandResult {
  message: string;
  speak: boolean;
  error?: boolean;
}

const OPENAI_VOICES = [
  'alloy', 'ash', 'ballad', 'cedar', 'coral',
  'echo', 'fable', 'marin', 'nova', 'onyx',
  'sage', 'shimmer', 'verse',
];

const SUPPORTED_PROVIDERS = ['openai', 'elevenlabs'];

const AVAILABLE_COMMANDS = [
  'on', 'off', 'mute', 'unmute', 'provider', 'speed', 'voice', 'voices', 'status', 'test',
];

const ENV_VAR_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
};

function updateConfigFile(updater: (config: Record<string, unknown>) => void): void {
  const configPath = getConfigPath();
  let config: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    // Start from empty if file missing or corrupt
  }
  updater(config);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

async function handleOn(sessionId: string | null): Promise<SubcommandResult> {
  if (!sessionId) {
    return {
      message:
        'Cannot determine the current session. Voice not activated. ' +
        'This usually means CLAUDE_CODE_SESSION_ID is unavailable — try restarting Claude Code.',
      speak: false,
      error: true,
    };
  }
  activate(sessionId);
  return { message: 'Voice output activated for this session.', speak: true };
}

async function handleOff(sessionId: string | null): Promise<SubcommandResult> {
  if (sessionId) deactivate(sessionId);
  return { message: 'Voice output off for this session.', speak: false };
}

/**
 * `!shutup`. A global stop: silence the machine and discard every session's
 * pending audio, because the user asked for quiet and cannot tell which
 * window is talking.
 */
async function handleStop(): Promise<SubcommandResult> {
  stopPlayback(null);
  return { message: '', speak: false };
}

/**
 * UserPromptSubmit. A stop scoped to the submitting session: it still kills
 * whatever is audible, but it must not discard another window's pending
 * narration — that message is never retried, and the user of that window
 * asked for nothing.
 */
async function handleTurnStart(sessionId: string | null): Promise<SubcommandResult> {
  stopPlayback(sessionId);
  if (sessionId) setSpokeThisTurn(sessionId, false);
  return { message: '', speak: false };
}

async function handleProvider(args: string[]): Promise<SubcommandResult> {
  const name = args[0]?.toLowerCase();
  if (!name) {
    return { message: 'Usage: provider <openai|elevenlabs>', speak: false, error: true };
  }
  if (!SUPPORTED_PROVIDERS.includes(name)) {
    return {
      message: `Unknown provider "${name}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
      speak: false,
      error: true,
    };
  }

  const config = loadConfig();
  const apiKey = config.apiKeys[name as keyof typeof config.apiKeys];
  if (!apiKey) {
    const envVar = ENV_VAR_MAP[name] ?? `${name.toUpperCase()}_API_KEY`;
    return {
      message: `No API key for ${name}. Set ${envVar} in your environment.`,
      speak: false,
      error: true,
    };
  }

  updateConfigFile((cfg) => {
    cfg.activeProvider = name;
    // Ensure provider block exists with defaults
    const providers = (cfg.providers as Record<string, unknown>) ?? {};
    if (!providers[name] && PROVIDER_DEFAULTS[name]) {
      providers[name] = { ...PROVIDER_DEFAULTS[name] };
    }
    cfg.providers = providers;
  });

  // Don't speak — the new provider may not have a voice configured yet
  const providerConfig = config.providers[name];
  const hasVoice = providerConfig?.voice || providerConfig?.voiceId;
  const hint = hasVoice ? '' : ' Run /speak: voices then /speak: voice [name] to configure a voice.';
  return { message: `Switched to ${name} provider.${hint}`, speak: false };
}

async function handleSpeed(args: string[]): Promise<SubcommandResult> {
  const raw = args[0];
  if (!raw) {
    return { message: 'Usage: speed <0.25-4.0>', speak: false, error: true };
  }

  const value = Number(raw);
  if (isNaN(value)) {
    return { message: `"${raw}" is not a number. Speed must be between 0.25 and 4.0.`, speak: false, error: true };
  }
  if (value < 0.25 || value > 4.0) {
    return { message: `Speed out of range. Must be between 0.25 and 4.0.`, speak: false, error: true };
  }

  const config = loadConfig();
  const provider = config.activeProvider;

  updateConfigFile((cfg) => {
    const providers = (cfg.providers ?? {}) as Record<string, Record<string, unknown>>;
    if (!providers[provider]) {
      providers[provider] = { ...(PROVIDER_DEFAULTS[provider] ?? { model: '', voice: '', speed: 1.0 }) };
    }
    providers[provider].speed = value;
    cfg.providers = providers;
  });

  return { message: `Speed set to ${value} for ${provider}.`, speak: true };
}

async function handleVoice(args: string[]): Promise<SubcommandResult> {
  const name = args.join(' ').trim();
  if (!name) {
    return { message: 'Usage: voice <name>', speak: false, error: true };
  }

  const config = loadConfig();
  const provider = config.activeProvider;

  if (provider === 'openai') {
    if (!OPENAI_VOICES.includes(name.toLowerCase())) {
      return {
        message: `Unknown OpenAI voice "${name}". Available: ${OPENAI_VOICES.join(', ')}`,
        speak: false,
        error: true,
      };
    }

    updateConfigFile((cfg) => {
      const providers = (cfg.providers ?? {}) as Record<string, Record<string, unknown>>;
      if (!providers.openai) {
        providers.openai = { ...PROVIDER_DEFAULTS.openai };
      }
      providers.openai.voice = name.toLowerCase();
      cfg.providers = providers;
    });

    return { message: `OpenAI voice set to ${name.toLowerCase()}.`, speak: true };
  }

  // ElevenLabs: resolve via cache, fall back to raw ID
  const cache = readCache();
  const voices = cache?.voices ?? [];
  const matches = resolveVoiceName(name, voices);

  if (matches.length > 1) {
    const list = matches.map((m) => `  ${m.name} (${m.voiceId})`).join('\n');
    return { message: `Multiple voices match "${name}":\n${list}\nBe more specific or use the voice ID directly.`, speak: false, error: true };
  }

  if (matches.length === 1) {
    const match = matches[0];
    updateConfigFile((cfg) => {
      const providers = (cfg.providers ?? {}) as Record<string, Record<string, unknown>>;
      if (!providers.elevenlabs) {
        providers.elevenlabs = { ...PROVIDER_DEFAULTS.elevenlabs };
      }
      providers.elevenlabs.voice = match.name;
      providers.elevenlabs.voiceId = match.voiceId;
      cfg.providers = providers;
    });
    return { message: `ElevenLabs voice set to ${match.name} (${match.voiceId}).`, speak: false };
  }

  // Treat as raw voice ID
  updateConfigFile((cfg) => {
    const providers = (cfg.providers ?? {}) as Record<string, Record<string, unknown>>;
    if (!providers.elevenlabs) {
      providers.elevenlabs = { ...PROVIDER_DEFAULTS.elevenlabs };
    }
    providers.elevenlabs.voice = name;
    providers.elevenlabs.voiceId = name;
    cfg.providers = providers;
  });

  return { message: `ElevenLabs voice set to ID ${name} (not found in cache, using as raw ID).`, speak: true };
}

async function handleVoices(): Promise<SubcommandResult> {
  const config = loadConfig();

  if (config.activeProvider === 'openai') {
    return {
      message: `OpenAI voices: ${OPENAI_VOICES.join(', ')}`,
      speak: false,
    };
  }

  // ElevenLabs
  const apiKey = config.apiKeys.elevenlabs;
  if (!apiKey) {
    return {
      message: 'No ElevenLabs API key set. Set ELEVENLABS_API_KEY in your environment.',
      speak: false,
      error: true,
    };
  }

  const voices = await fetchElevenLabsVoices(apiKey);
  writeCache(voices);

  const lines = voices.map((v) => `  ${v.name} [${v.category}] (${v.voiceId})`);
  return {
    message: `ElevenLabs voices:\n${lines.join('\n')}`,
    speak: false,
  };
}

async function handleStatus(sessionId: string | null): Promise<SubcommandResult> {
  const config = loadConfig();
  const provider = config.activeProvider;
  const providerConfig = config.providers[provider];

  const lines = [
    `Session: ${sessionId ?? 'unknown'}`,
    `Voice: ${isActive(sessionId) ? 'active' : 'off'}`,
    `Provider: ${provider}`,
    `Voice name: ${providerConfig?.voice ?? '(not set)'}`,
    `Speed: ${providerConfig?.speed ?? 1.0}`,
    `Condense: ${config.speech.condense} (over ${config.speech.maxChars} chars)`,
    `Hooks: stop=${config.hooks.stop}, notification=${config.hooks.notification}`,
  ];

  return { message: lines.join('\n'), speak: false };
}

async function handleTest(): Promise<SubcommandResult> {
  const config = loadConfig();
  const provider = config.activeProvider;
  const providerConfig = config.providers[provider];
  const voice = providerConfig?.voice ?? 'default';
  const speed = providerConfig?.speed ?? 1.0;

  return {
    message: `This is a test of claude-speak using ${provider} with voice ${voice} at speed ${speed}.`,
    speak: true,
  };
}

export async function dispatch(
  cmd: string,
  args: string[],
  sessionId: string | null,
): Promise<SubcommandResult> {
  switch (cmd) {
    case 'on':
    case 'unmute':
      return handleOn(sessionId);
    case 'off':
    case 'mute':
      return handleOff(sessionId);
    case 'stop':
      return handleStop();
    case 'turn-start':
      return handleTurnStart(sessionId);
    case 'gc':
      gcSessions();
      return { message: '', speak: false };
    case 'provider':
      return handleProvider(args);
    case 'speed':
      return handleSpeed(args);
    case 'voice':
      return handleVoice(args);
    case 'voices':
      return handleVoices();
    case 'status':
      return handleStatus(sessionId);
    case 'test':
      return handleTest();
    default:
      return {
        message: `Unknown command "${cmd}". Available: ${AVAILABLE_COMMANDS.join(', ')}`,
        speak: false,
        error: true,
      };
  }
}
