import { loadConfig, type VoiceConfig } from './config.js';
import {
  resolveSessionId,
  isActive,
  setSpokeThisTurn,
  consumeSpokeThisTurn,
} from './session.js';
import { extractMessage } from './extractor.js';
import { sanitize } from './sanitizer.js';
import { createProvider } from './tts/factory.js';
import { shouldCondense, heuristicCondense } from './condenser.js';
import { summarizeForSpeech } from './summarizer.js';
import { playAudio, readStopEpoch } from './player.js';
import { writeLock, isLocked } from './lock.js';
import { handleError } from './error.js';
import { dispatch } from './subcommands.js';
import * as path from 'node:path';

const DEBUG = process.env.CLAUDE_SPEAK_DEBUG === '1';
function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[claude-speak] ${msg}\n`);
}

/**
 * Condense passive-path text that is too long or too structured to speak.
 *
 * Tier order: LLM rewrite, then the deterministic heuristic. Never returns the
 * raw text once shouldCondense has said it is unlistenable.
 */
async function condenseForSpeech(text: string, config: VoiceConfig): Promise<string> {
  if (!config.speech.condense) return text;
  if (!shouldCondense(text, config.speech.maxChars)) return text;

  debug('condensing: over threshold');
  const rewritten = await summarizeForSpeech(text, config);
  if (rewritten) return rewritten;

  debug('condensing: summarizer unavailable, using heuristic');
  return heuristicCondense(text, config.speech.maxChars);
}

/**
 * Synthesis takes 1-2 seconds. A stop request arriving in that window would
 * otherwise kill a pid that does not exist yet, and audio would begin after
 * the user asked for silence.
 */
function stopRequestedSince(requestedAt: number): boolean {
  return readStopEpoch() > requestedAt;
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
    const requestedAt = Date.now();
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

    if (stopRequestedSince(requestedAt)) {
      debug('EXIT: stop requested during synthesis');
      return;
    }

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

  const sessionId = resolveSessionId(stdin);
  debug(`sessionId=${sessionId}`);

  // Check for --cmd routing first (must work while voice is off, so the user
  // can turn it on, stop playback, or check status)
  const cmdIndex = args.indexOf('--cmd');
  if (cmdIndex !== -1) {
    const subCmd = args[cmdIndex + 1];
    if (!subCmd) {
      // Mirrors AVAILABLE_COMMANDS in subcommands.ts. `stop` and `turn-start`
      // are deliberately absent: they are internal entry points for bin/shutup
      // and the UserPromptSubmit hook, not commands to advertise here.
      process.stdout.write('Usage: --cmd <subcommand> [args]\nAvailable: on, off, mute, unmute, provider, speed, voice, voices, status, test\n');
      return;
    }
    const subArgs = args.slice(cmdIndex + 2);
    const result = await dispatch(subCmd, subArgs, sessionId);
    if (result.message) process.stdout.write(result.message + '\n');
    // Subcommand confirmations obey the activation gate like everything else.
    // `on` still confirms audibly because handleOn activates before returning.
    if (result.speak && result.message && isActive(sessionId)) {
      // Reload config in case the subcommand changed it (e.g., provider, speed, voice)
      const freshConfig = loadConfig();
      await speakText(result.message, freshConfig);
    }
    return;
  }

  // Activation gate for non-cmd paths: voice is off until deliberately enabled.
  if (!isActive(sessionId)) { debug('EXIT: session not active'); return; }

  const sayIndex = args.indexOf('--say');
  const triggerIndex = args.indexOf('--trigger');

  let text: string | null = null;
  let isActiveVoice = false;

  if (sayIndex !== -1 && args[sayIndex + 1]) {
    // Active voice mode: write lock immediately so the Stop hook sees it
    writeLock(getLockPath());
    if (sessionId) setSpokeThisTurn(sessionId, true);
    text = args[sayIndex + 1];
    isActiveVoice = true;
  } else if (triggerIndex !== -1 && args[triggerIndex + 1]) {
    // Passive voice mode
    const triggerType = args[triggerIndex + 1] as 'stop' | 'notification';

    // Check if this hook type is enabled
    if (!config.hooks[triggerType]) return;

    if (triggerType === 'stop') {
      // Exact, turn-scoped dedup. Always consumes the flag.
      if (sessionId && consumeSpokeThisTurn(sessionId)) {
        debug('EXIT: active voice already spoke this turn');
        return;
      }
    } else {
      // Notifications are not turn-scoped — several can fire in one turn — so
      // the cooldown lock remains the right rate limiter here.
      const lockPath = getLockPath();
      debug(`lockPath=${lockPath} cooldown=${config.cooldown} locked=${isLocked(lockPath, config.cooldown)}`);
      if (isLocked(lockPath, config.cooldown)) { debug('EXIT: locked'); return; }
    }

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

  // Stamped before condensation rather than immediately before synthesis: the
  // summarizer can block for seconds, and that window is widest exactly when
  // the network is degraded — which is when a user is most likely to give up
  // and hit stop. A stop landing anywhere from here to playback is honoured.
  const requestedAt = Date.now();

  // Condensation is passive-path only: active voice text is hand written for
  // the ear already, and rewriting it would only degrade it.
  if (!isActiveVoice) {
    text = await condenseForSpeech(text, config);
    if (!text) { debug('EXIT: condensed to nothing'); return; }
  }

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

    if (stopRequestedSince(requestedAt)) {
      debug('EXIT: stop requested since the message was prepared');
      return;
    }

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
