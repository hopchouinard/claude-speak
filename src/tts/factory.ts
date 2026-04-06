import type { TTSProvider } from './interface.js';
import type { ApiKeys } from '../config.js';
import { OpenAITTSProvider } from './openai.js';
import { ElevenLabsTTSProvider } from './elevenlabs.js';

export function createProvider(providerName: string, apiKeys: ApiKeys): TTSProvider {
  switch (providerName) {
    case 'openai': {
      if (!apiKeys.openai) {
        throw new Error('OpenAI API key not found. Set OPENAI_API_KEY or configure via plugin settings.');
      }
      return new OpenAITTSProvider(apiKeys.openai);
    }
    case 'elevenlabs': {
      if (!apiKeys.elevenlabs) {
        throw new Error('ElevenLabs API key not found. Add `export ELEVENLABS_API_KEY=xi-...` to ~/.claude-speak/env');
      }
      return new ElevenLabsTTSProvider(apiKeys.elevenlabs);
    }
    default:
      throw new Error(`Unknown TTS provider: ${providerName}. Supported providers: openai, elevenlabs`);
  }
}
