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
export declare function loadConfig(): VoiceConfig;
