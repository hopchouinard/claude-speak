import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
function getDefaults() {
    return {
        provider: 'openai',
        model: 'gpt-4o-mini-tts-2025-12-15',
        voice: 'ash',
        instructions: '',
        hooks: { stop: true, notification: true },
        playback: { command: detectPlaybackCommand() },
        cooldown: 15,
        timeout: 30,
        logFile: path.join(os.homedir(), '.claude-voice', 'logs', 'voice.log'),
    };
}
function expandTilde(filePath) {
    if (filePath.startsWith('~/')) {
        return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
}
function detectPlaybackCommand() {
    return process.platform === 'darwin' ? 'afplay' : 'paplay';
}
export function loadConfig() {
    const DEFAULTS = getDefaults();
    const configPath = path.join(os.homedir(), '.claude-voice.json');
    const envEnabled = process.env.CLAUDE_VOICE_ENABLED;
    const apiKey = process.env.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
    if (!fs.existsSync(configPath)) {
        return {
            ...DEFAULTS,
            enabled: false,
            apiKey,
        };
    }
    let fileConfig;
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        fileConfig = JSON.parse(raw);
    }
    catch {
        return {
            ...DEFAULTS,
            enabled: false,
            apiKey,
            error: 'malformed-config',
        };
    }
    const merged = {
        provider: fileConfig.provider ?? DEFAULTS.provider,
        model: fileConfig.model ?? DEFAULTS.model,
        voice: fileConfig.voice ?? DEFAULTS.voice,
        instructions: fileConfig.instructions ?? DEFAULTS.instructions,
        hooks: {
            stop: fileConfig.hooks?.stop ?? DEFAULTS.hooks.stop,
            notification: fileConfig.hooks?.notification ?? DEFAULTS.hooks.notification,
        },
        playback: {
            command: fileConfig.playback?.command ?? DEFAULTS.playback.command,
        },
        cooldown: fileConfig.cooldown ?? DEFAULTS.cooldown,
        timeout: fileConfig.timeout ?? DEFAULTS.timeout,
        logFile: expandTilde(fileConfig.logFile ?? DEFAULTS.logFile),
        enabled: envEnabled !== undefined ? envEnabled === 'true' : true,
        apiKey,
    };
    return merged;
}
//# sourceMappingURL=config.js.map