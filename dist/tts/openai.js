import OpenAI from 'openai';
export class OpenAITTSProvider {
    client;
    constructor(apiKey) {
        this.client = new OpenAI({ apiKey });
    }
    async synthesize(text, options) {
        const params = {
            model: options.model,
            voice: options.voice,
            input: text,
            ...(options.instructions ? { instructions: options.instructions } : {}),
        };
        const response = await this.client.audio.speech.create(params);
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }
}
//# sourceMappingURL=openai.js.map