export interface TTSOptions {
  voice: string;
  model: string;
  instructions?: string;
}

export interface TTSProvider {
  synthesize(text: string, options: TTSOptions): Promise<Buffer>;
}
