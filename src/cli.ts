import { loadConfig, type VoiceConfig } from './config.js';
import { loadSession } from './session.js';
import { extractMessage } from './extractor.js';
import { sanitize } from './sanitizer.js';
import { createProvider } from './tts/factory.js';
import { playAudio } from './player.js';
import { writeLock, isLocked } from './lock.js';
import { handleError } from './error.js';
import { dispatch } from './subcommands.js';
import * as path from 'node:path';

const DEBUG = process.env.CLAUDE_SPEAK_DEBUG === '1';
function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[claude-speak] ${msg}\n`);
}

async function speakText(text: string, config: VoiceConfig): Promise<void> {
  const providerConfig = config.providers[config.activeProvider];
  const apiKey = config.apiKeys[config.activeProvider as keyof typeof config.apiKeys];

  if (!apiKey) {
    handleError(
      new Error(`No API key for ${config.activeProvider}. Set the appropriate environment variable.`),
      config.logFile,
    );
    return;
  }

  const sanitized = sanitize(text);
  if (!sanitized) return;

  try {
    const provider = createProvider(config.activeProvider, config.apiKeys);
    const audio = await provider.synthesize(sanitized, {
      voice: providerConfig?.voice ?? 'ash',
      model: providerConfig?.model ?? 'gpt-4o-mini-tts-2025-12-15',
      instructions: providerConfig?.instructions,
      speed: providerConfig?.speed,
      voiceId: providerConfig?.voiceId,
      stability: providerConfig?.stability,
      similarityBoost: providerConfig?.similarityBoost,
      style: providerConfig?.style,
    });

    playAudio(audio, config.playback.command);
  } catch (err) {
    debug(`TTS ERROR: ${err instanceof Error ? err.message : String(err)}`);
    handleError(err, config.logFile);
  }
}

export async function run(args: string[], stdin: string): Promise<void> {
  const config = loadConfig();
  debug(`enabled=${config.enabled} activeProvider=${config.activeProvider} args=${JSON.stringify(args)}`);
  debug(`stdin length=${stdin.length} stdin FULL=${JSON.stringify(stdin)}`);

  if (!config.enabled) { debug('EXIT: disabled'); return; }

  const session = loadSession();

  // Check for --cmd routing first (must work even when muted, so user can unmute)
  const cmdIndex = args.indexOf('--cmd');
  if (cmdIndex !== -1 && args[cmdIndex + 1]) {
    const subCmd = args[cmdIndex + 1];
    const subArgs = args.slice(cmdIndex + 2);
    const result = await dispatch(subCmd, subArgs);
    if (result.message) process.stdout.write(result.message + '\n');
    if (result.speak && result.message) await speakText(result.message, config);
    return;
  }

  // Mute check for non-cmd paths
  if (session.muted) { debug('EXIT: muted'); return; }

  const sayIndex = args.indexOf('--say');
  const triggerIndex = args.indexOf('--trigger');

  let text: string | null = null;
  let isActiveVoice = false;

  if (sayIndex !== -1 && args[sayIndex + 1]) {
    // Active voice mode: write lock immediately so the Stop hook sees it
    writeLock(getLockPath());
    text = args[sayIndex + 1];
    isActiveVoice = true;
  } else if (triggerIndex !== -1 && args[triggerIndex + 1]) {
    // Passive voice mode
    const triggerType = args[triggerIndex + 1] as 'stop' | 'notification';

    // Check if this hook type is enabled
    if (!config.hooks[triggerType]) return;

    // Check lockfile for active/passive dedup
    const lockPath = getLockPath();
    debug(`lockPath=${lockPath} cooldown=${config.cooldown} locked=${isLocked(lockPath, config.cooldown)}`);
    if (isLocked(lockPath, config.cooldown)) { debug('EXIT: locked by active voice'); return; }

    text = extractMessage(stdin);
    debug(`extracted text=${text ? text.slice(0, 100) : 'null'}`);

    // For notification triggers, filter out idle system notifications
    if (triggerType === 'notification' && text && isIdleNotification(text)) {
      debug('EXIT: filtered idle notification');
      return;
    }
  } else {
    debug('EXIT: no valid args');
    return;
  }

  if (!text) { debug('EXIT: no text'); return; }

  // Check API key for active provider
  const apiKey = config.apiKeys[config.activeProvider as keyof typeof config.apiKeys];
  if (!apiKey) {
    handleError(
      new Error(`No API key for ${config.activeProvider}. Set the appropriate environment variable.`),
      config.logFile,
    );
    return;
  }

  // Sanitize
  const sanitized = sanitize(text);
  if (!sanitized) return;

  // TTS
  try {
    const providerConfig = config.providers[config.activeProvider];
    const provider = createProvider(config.activeProvider, config.apiKeys);
    const audio = await provider.synthesize(sanitized, {
      voice: providerConfig?.voice ?? 'ash',
      model: providerConfig?.model ?? 'gpt-4o-mini-tts-2025-12-15',
      instructions: providerConfig?.instructions,
      speed: providerConfig?.speed,
      voiceId: providerConfig?.voiceId,
      stability: providerConfig?.stability,
      similarityBoost: providerConfig?.similarityBoost,
      style: providerConfig?.style,
    });

    playAudio(audio, config.playback.command);

    // Refresh lock after playback starts so the Stop hook sees a fresh timestamp
    if (isActiveVoice) {
      writeLock(getLockPath());
    }
  } catch (err) {
    debug(`TTS ERROR: ${err instanceof Error ? err.message : String(err)}`);
    handleError(err, config.logFile);
  }
}

// Patterns that match system idle/status notifications not worth speaking aloud.
// These are generated by Claude Code itself, not by the assistant's response.
const IDLE_NOTIFICATION_PATTERNS = [
  /waiting\s+for\s+(your\s+)?input/i,
  /waiting\s+for\s+(your\s+)?response/i,
  /ready\s+for\s+(your\s+)?(next\s+)?input/i,
  /awaiting\s+(your\s+)?input/i,
];

export function isIdleNotification(text: string): boolean {
  return IDLE_NOTIFICATION_PATTERNS.some((pattern) => pattern.test(text));
}

function getLockPath(): string {
  // Always use ~/.claude-speak/ for the lock file, regardless of CLAUDE_PLUGIN_DATA.
  return path.join(process.env.HOME || '', '.claude-speak', 'voice.lock');
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
