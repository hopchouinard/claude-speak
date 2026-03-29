import { loadConfig } from './config.js';
import { extractMessage } from './extractor.js';
import { sanitize } from './sanitizer.js';
import { OpenAITTSProvider } from './tts/openai.js';
import { playAudio } from './player.js';
import { writeLock, isLocked } from './lock.js';
import { handleError } from './error.js';
import * as path from 'node:path';
export async function run(args, stdin) {
    const config = loadConfig();
    if (!config.enabled)
        return;
    const sayIndex = args.indexOf('--say');
    const triggerIndex = args.indexOf('--trigger');
    let text = null;
    let isActiveVoice = false;
    if (sayIndex !== -1 && args[sayIndex + 1]) {
        // Active voice mode
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
        if (isLocked(lockPath, config.cooldown))
            return;
        text = extractMessage(stdin);
    }
    else {
        return;
    }
    if (!text)
        return;
    if (!config.apiKey) {
        handleError(new Error('No API key configured. Set OPENAI_API_KEY or configure via plugin settings.'), config.logFile);
        return;
    }
    // Sanitize
    const sanitized = sanitize(text);
    if (!sanitized)
        return;
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
    }
    catch (err) {
        handleError(err, config.logFile);
    }
}
function getLockPath() {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(process.env.HOME || '', '.claude-voice');
    return path.join(dataDir, 'voice.lock');
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