import { loadConfig } from './config.js';
import { extractMessage } from './extractor.js';
import { sanitize } from './sanitizer.js';
import { OpenAITTSProvider } from './tts/openai.js';
import { playAudio } from './player.js';
import { writeLock, isLocked } from './lock.js';
import { handleError } from './error.js';
import * as path from 'node:path';

const DEBUG = process.env.CLAUDE_VOICE_DEBUG === '1';
function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[claude-voice] ${msg}\n`);
}

export async function run(args: string[], stdin: string): Promise<void> {
  const config = loadConfig();
  debug(`enabled=${config.enabled} apiKey=${config.apiKey ? 'set' : 'null'} args=${JSON.stringify(args)}`);
  debug(`stdin length=${stdin.length} stdin FULL=${JSON.stringify(stdin)}`);

  if (!config.enabled) { debug('EXIT: disabled'); return; }

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
    debug(`extracted text=${text ? text.slice(0, 100) : 'null'}`);
  } else {
    debug('EXIT: no valid args');
    return;
  }

  if (!text) { debug('EXIT: no text'); return; }

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
    debug(`TTS ERROR: ${err instanceof Error ? err.message : String(err)}`);
    handleError(err, config.logFile);
  }
}

function getLockPath(): string {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(process.env.HOME || '', '.claude-voice');
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
    console.error('claude-voice fatal:', err);
    process.exit(1);
  });
}
