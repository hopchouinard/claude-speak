import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAITTSProvider } from '../src/tts/openai.js';

// Mock the openai module
vi.mock('openai', () => {
  const mockCreate = vi.fn();
  return {
    default: class {
      audio = { speech: { create: mockCreate } };
    },
    __mockCreate: mockCreate,
  };
});

describe('OpenAITTSProvider', () => {
  let provider: OpenAITTSProvider;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('openai');
    mockCreate = (mod as unknown as { __mockCreate: ReturnType<typeof vi.fn> }).__mockCreate;
    mockCreate.mockReset();
    provider = new OpenAITTSProvider('sk-test-key');
  });

  it('calls OpenAI API with correct parameters', async () => {
    const fakeAudio = Buffer.from('fake-audio-data');
    mockCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(fakeAudio.buffer),
    });

    await provider.synthesize('Hello world', {
      voice: 'ash',
      model: 'gpt-4o-mini-tts-2025-12-15',
      instructions: 'Be concise',
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'ash',
      input: 'Hello world',
      instructions: 'Be concise',
    });
  });

  it('returns audio buffer from API response', async () => {
    const fakeAudio = Buffer.from('fake-audio-data');
    mockCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(fakeAudio.buffer),
    });

    const result = await provider.synthesize('Hello', {
      voice: 'ash',
      model: 'gpt-4o-mini-tts-2025-12-15',
    });

    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it('omits instructions when not provided', async () => {
    mockCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(Buffer.from('audio').buffer),
    });

    await provider.synthesize('Hello', {
      voice: 'ash',
      model: 'gpt-4o-mini-tts-2025-12-15',
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'ash',
      input: 'Hello',
    });
  });

  it('propagates API errors', async () => {
    mockCreate.mockRejectedValue(new Error('API rate limit exceeded'));

    await expect(
      provider.synthesize('Hello', { voice: 'ash', model: 'gpt-4o-mini-tts-2025-12-15' })
    ).rejects.toThrow('API rate limit exceeded');
  });
});
