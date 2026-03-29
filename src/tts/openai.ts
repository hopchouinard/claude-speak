import OpenAI from 'openai';
import type { TTSProvider, TTSOptions } from './interface.js';

export class OpenAITTSProvider implements TTSProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async synthesize(text: string, options: TTSOptions): Promise<Buffer> {
    const params: Record<string, unknown> = {
      model: options.model,
      voice: options.voice,
      input: text,
    };

    if (options.instructions) {
      params.instructions = options.instructions;
    }

    const response = await this.client.audio.speech.create(params as Parameters<typeof this.client.audio.speech.create>[0]);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
