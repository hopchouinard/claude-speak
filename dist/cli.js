import { loadConfig } from './config.js';
import { extractMessage } from './extractor.js';
import { sanitize } from './sanitizer.js';
import { OpenAITTSProvider } from './tts/openai.js';
import { playAudio } from './player.js';
import { writeLock, isLocked } from './lock.js';
import { handleError } from './error.js';
import * as path from 'node:path';
const DEBUG = process.env.CLAUDE_VOICE_DEBUG === '1';
function debug(msg) {
    if (DEBUG)
        process.stderr.write(`[claude-voice] ${msg}\n`);
}
export async function run(args, stdin) {
    const config = loadConfig();
    debug(`enabled=${config.enabled} apiKey=${config.apiKey ? 'set' : 'null'} args=${JSON.stringify(args)}`);
    debug(`stdin length=${stdin.length} stdin FULL=${JSON.stringify(stdin)}`);
    if (!config.enabled) {
        debug('EXIT: disabled');
        return;
    }
    const sayIndex = args.indexOf('--say');
    const triggerIndex = args.indexOf('--trigger');
    let text = null;
    let isActiveVoice = false;
    if (sayIndex !== -1 && args[sayIndex + 1]) {
        // Active voice mode — write lock immediately so the Stop hook sees it
        writeLock(getLockPath());
        text = args[sayIndex + 1];
        isActiveVoice = true;
    }
    else if (triggerIndex !== -1 && args[triggerIndex + 1]) {
        // Passive voice mode
        const triggerType = args[triggerIndex + 1];
        // Check if this hook type is enabled
        if (!config.hooks[triggerType])
            return;
        // Check lockfile for active/passive dedup
        const lockPath = getLockPath();
        debug(`lockPath=${lockPath} cooldown=${config.cooldown} locked=${isLocked(lockPath, config.cooldown)}`);
        if (isLocked(lockPath, config.cooldown)) {
            debug('EXIT: locked by active voice');
            return;
        }
        text = extractMessage(stdin);
        debug(`extracted text=${text ? text.slice(0, 100) : 'null'}`);
    }
    else {
        debug('EXIT: no valid args');
        return;
    }
    if (!text) {
        debug('EXIT: no text');
        return;
    }
    if (!config.apiKey) {
        handleError(new Error('No API key configured. Set OPENAI_API_KEY or configure via plugin settings.'), config.logFile);
        return;
    }
    // Sanitize
    const sanitized = sanitize(text);
    if (!sanitized)
        return;
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
        // Refresh lock after playback starts so the Stop hook sees a fresh timestamp
        if (isActiveVoice) {
            writeLock(getLockPath());
        }
    }
    catch (err) {
        debug(`TTS ERROR: ${err instanceof Error ? err.message : String(err)}`);
        handleError(err, config.logFile);
    }
}
function getLockPath() {
    // Always use ~/.claude-voice/ for the lock file, regardless of CLAUDE_PLUGIN_DATA.
    // This ensures the active voice (invoked via Bash tool) and passive voice (invoked
    // via hook with CLAUDE_PLUGIN_DATA set) read/write the same file.
    return path.join(process.env.HOME || '', '.claude-voice', 'voice.lock');
}
// Main execution when run as script
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainModule) {
    let stdin = '';
    if (!process.stdin.isTTY) {
        const chunks = [];
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
//# sourceMappingURL=cli.js.map