import type { TTSProvider, TTSOptions } from './interface.js';
export declare class OpenAITTSProvider implements TTSProvider {
    private client;
    constructor(apiKey: string);
    synthesize(text: string, options: TTSOptions): Promise<Buffer>;
}
