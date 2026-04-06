import type { TTSProvider, TTSOptions } from './interface.js';

export class ElevenLabsTTSProvider implements TTSProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async synthesize(text: string, options: TTSOptions): Promise<Buffer> {
    const voiceId = options.voiceId || options.voice;
    if (!voiceId) {
      throw new Error('No voice configured for ElevenLabs. Run /speak: voices to fetch your voice list, then /speak: voice [name] to select one.');
    }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const voiceSettings: Record<string, number> = {};
    if (options.speed != null) voiceSettings.speed = options.speed;
    if (options.stability != null) voiceSettings.stability = options.stability;
    if (options.similarityBoost != null) voiceSettings.similarity_boost = options.similarityBoost;
    if (options.style != null) voiceSettings.style = options.style;

    const body: Record<string, unknown> = {
      text,
      model_id: options.model,
    };

    if (Object.keys(voiceSettings).length > 0) {
      body.voice_settings = voiceSettings;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
