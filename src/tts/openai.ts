import OpenAI from 'openai';
import type { TTSProvider, TTSOptions } from './interface.js';

export class OpenAITTSProvider implements TTSProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async synthesize(text: string, options: TTSOptions): Promise<Buffer> {
    const params = {
      model: options.model,
      voice: options.voice.toLowerCase(),
      input: text,
      ...(options.instructions ? { instructions: options.instructions } : {}),
      ...(options.speed != null ? { speed: options.speed } : {}),
    } as Parameters<typeof this.client.audio.speech.create>[0];

    const response = await this.client.audio.speech.create(params);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
