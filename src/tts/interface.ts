export interface TTSOptions {
  voice: string;
  model: string;
  instructions?: string;
  speed?: number;
  voiceId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
}

export interface TTSProvider {
  synthesize(text: string, options: TTSOptions): Promise<Buffer>;
}
