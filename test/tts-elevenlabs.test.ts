import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ElevenLabsTTSProvider } from '../src/tts/elevenlabs.js';

describe('ElevenLabsTTSProvider', () => {
  let provider: ElevenLabsTTSProvider;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    provider = new ElevenLabsTTSProvider('el-test-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls ElevenLabs API with correct URL and headers', async () => {
    const fakeAudio = new Uint8Array([1, 2, 3]).buffer;
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    await provider.synthesize('Hello world', {
      voice: 'some-voice-id',
      model: 'eleven_multilingual_v2',
      speed: 1.0,
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0.0,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/some-voice-id');
    expect(options.headers['xi-api-key']).toBe('el-test-key');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.headers['Accept']).toBe('audio/mpeg');
  });

  it('sends correct request body with voice_settings', async () => {
    const fakeAudio = new Uint8Array([1, 2, 3]).buffer;
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    await provider.synthesize('Hello world', {
      voice: 'some-voice-id',
      model: 'eleven_multilingual_v2',
      speed: 1.2,
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0.1,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe('Hello world');
    expect(body.model_id).toBe('eleven_multilingual_v2');
    expect(body.voice_settings.speed).toBe(1.2);
    expect(body.voice_settings.stability).toBe(0.5);
    expect(body.voice_settings.similarity_boost).toBe(0.75);
    expect(body.voice_settings.style).toBe(0.1);
  });

  it('returns audio buffer', async () => {
    const fakeAudio = new Uint8Array([1, 2, 3]).buffer;
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    const result = await provider.synthesize('Hello', {
      voice: 'some-voice-id',
      model: 'eleven_multilingual_v2',
    });

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(3);
  });

  it('throws on API error with status code', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(
      provider.synthesize('Hello', {
        voice: 'some-voice-id',
        model: 'eleven_multilingual_v2',
      })
    ).rejects.toThrow('ElevenLabs API error: 401 Unauthorized');
  });

  it('uses voiceId over voice name for URL construction', async () => {
    const fakeAudio = new Uint8Array([1, 2, 3]).buffer;
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    await provider.synthesize('Hello', {
      voice: 'Rachel',
      voiceId: 'actual-voice-id-123',
      model: 'eleven_multilingual_v2',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/actual-voice-id-123');
  });
});
