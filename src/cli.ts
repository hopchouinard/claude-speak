import { loadConfig, type VoiceConfig } from './config.js';
import {
  resolveSessionId,
  isActive,
  setSpokeThisTurn,
  consumeSpokeThisTurn,
  consumeSilencedThisTurn,
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
 * Spoken when condensation strips a message to nothing — a message that is
 * only a table or only a fenced code block has no extractive summary. Silence
 * would look like a broken plugin, so say that something happened and point at
 * the screen for the detail.
 */
const EMPTY_CONDENSE_FALLBACK = 'That message does not read aloud well. The details are on screen.';

/**
 * Condense passive-path text that is too long or too structured to speak.
 *
 * Tier order: LLM rewrite, then the deterministic heuristic. Never returns the
 * raw text once shouldCondense has said it is unlistenable, and never returns
 * empty once it has decided to condense something.
 */
async function condenseForSpeech(text: string, config: VoiceConfig): Promise<string> {
  if (!config.speech.condense) return text;
  if (!shouldCondense(text, config.speech.maxChars)) return text;

  debug('condensing: over threshold');
  const rewritten = await summarizeForSpeech(text, config);
  if (rewritten) return rewritten;

  debug('condensing: summarizer unavailable, using heuristic');
  const condensed = heuristicCondense(text, config.speech.maxChars);
  if (condensed) return condensed;

  debug('condensing: heuristic left nothing, speaking the fallback');
  return EMPTY_CONDENSE_FALLBACK;
}

/**
 * Synthesis takes 1-2 seconds. A stop request arriving in that window would
 * otherwise kill a pid that does not exist yet, and audio would begin after
 * the user asked for silence.
 *
 * Scoped to the calling session: the stop epoch is machine-global, and an
 * unscoped read lets one window's prompt submission discard another window's
 * narration outright (see stopPlayback in player.ts).
 */
function stopRequestedSince(requestedAt: number, sessionId: string | null): boolean {
  return readStopEpoch(sessionId) > requestedAt;
}

async function speakText(text: string, config: VoiceConfig, sessionId: string | null): Promise<void> {
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
    // Stamped immediately before synthesis, unlike run()'s copy of this guard,
    // which stamps before condensation. The difference is deliberate: this
    // path has no condensation step to cover. The duplication is deliberate
    // too — any future shared extraction must preserve BOTH stamp positions,
    // or one of the two paths loses part of its stop window.
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

    if (stopRequestedSince(requestedAt, sessionId)) {
      debug('EXIT: stop requested during synthesis');
      return;
    }

    playAudio(audio, config.playback.command, sessionId);
  } catch (err) {
    debug(`TTS ERROR: ${err instanceof Error ? err.message : String(err)}`);
    handleError(err, config.logFile);
  }
}

export async function run(args: string[], stdin: string): Promise<void> {
  const config = loadConfig();
  debug(`enabled=${config.enabled} activeProvider=${config.activeProvider} args=${JSON.stringify(args)}`);
  debug(`stdin length=${stdin.length} stdin FULL=${JSON.stringify(stdin)}`);

  const sessionId = resolveSessionId(stdin);
  debug(`sessionId=${sessionId}`);

  const cmdIndex = args.indexOf('--cmd');

  // Housekeeping runs ahead of the kill switch. Session files accumulate
  // whether or not voice is enabled, and SessionStart is the only thing that
  // ever collects them (or removes the legacy 1.x session.json). Gating GC on
  // `enabled` would leave a user who set it to false with state that grows
  // forever and never migrates.
  if (cmdIndex !== -1 && args[cmdIndex + 1] === 'gc') {
    debug('running gc');
    await dispatch('gc', [], sessionId);
    return;
  }

  if (!config.enabled) { debug('EXIT: disabled'); return; }

  // Check for --cmd routing first (must work while voice is off, so the user
  // can turn it on, stop playback, or check status)
  if (cmdIndex !== -1) {
    const subCmd = args[cmdIndex + 1];
    if (!subCmd) {
      // Mirrors AVAILABLE_COMMANDS in subcommands.ts. `stop`, `turn-start` and
      // `gc` are deliberately absent: they are internal entry points for
      // bin/shutup, the UserPromptSubmit hook and the SessionStart hook
      // respectively, not commands to advertise here.
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
      await speakText(result.message, freshConfig, sessionId);
      // This turn has now been spoken. Without the flag the Stop hook also
      // narrates the final message, so `/speak on` says "Voice output
      // activated" and then "Voice is on" — the same double-speech the flag
      // exists to prevent, just arriving through the subcommand path.
      if (sessionId) setSpokeThisTurn(sessionId, true);
    }
    return;
  }

  // Activation gate for non-cmd paths: voice is off until deliberately enabled.
  if (!isActive(sessionId)) { debug('EXIT: session not active'); return; }

  const sayIndex = args.indexOf('--say');
  const triggerIndex = args.indexOf('--trigger');

  let text: string | null = null;
  let isActiveVoice = false;
  let isNotification = false;

  if (sayIndex !== -1 && args[sayIndex + 1]) {
    // Active voice mode: write lock immediately so the Stop hook sees it
    writeLock(getLockPath());
    if (sessionId) setSpokeThisTurn(sessionId, true);
    text = args[sayIndex + 1];
    isActiveVoice = true;
  } else if (triggerIndex !== -1 && args[triggerIndex + 1]) {
    // Passive voice mode
    const triggerType = args[triggerIndex + 1] as 'stop' | 'notification';
    isNotification = triggerType === 'notification';

    // Check if this hook type is enabled
    if (!config.hooks[triggerType]) { debug(`EXIT: hook ${triggerType} disabled in config`); return; }

    if (triggerType === 'stop') {
      // The user asked for silence during this turn. Answering that with a
      // fresh spoken message is the opposite of what was asked, so the
      // end-of-turn narration is dropped. Consumed either way, so the next
      // turn speaks normally without needing /speak on again.
      if (sessionId && consumeSilencedThisTurn(sessionId)) {
        debug('EXIT: stop requested during this turn');
        return;
      }

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
  //
  // speakText() carries a near-identical guard stamped just before synthesis.
  // The duplication is deliberate and the two stamp positions are not
  // interchangeable: extracting a shared helper must preserve both.
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

    if (stopRequestedSince(requestedAt, sessionId)) {
      debug('EXIT: stop requested since the message was prepared');
      return;
    }

    playAudio(audio, config.playback.command, sessionId);

    // Refresh the lock after playback starts.
    //
    // Active voice: so the Stop hook sees a fresh timestamp.
    //
    // Notifications: so the cooldown actually rate-limits them. This path
    // gates on isLocked but nothing used to write the lock, so several
    // notifications in one turn all passed the check and spoke over each
    // other — the documented cooldown had no effect on the only trigger it
    // still governs.
    if (isActiveVoice || isNotification) {
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
