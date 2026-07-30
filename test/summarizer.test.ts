import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { summarizeForSpeech } from '../src/summarizer.js';
import type { VoiceConfig } from '../src/config.js';

vi.mock('../src/error.js');

function makeConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    enabled: true,
    activeProvider: 'openai',
    providers: { openai: { model: 'tts', voice: 'ash', speed: 1.0 } },
    apiKeys: { openai: 'sk-test', elevenlabs: null },
    hooks: { stop: true, notification: true },
    playback: { command: 'afplay' },
    speech: {
      maxChars: 500,
      condense: true,
      summarizer: { model: 'gpt-5.4-nano-2026-03-17', timeout: 8, maxWords: 40 },
    },
    cooldown: 15,
    timeout: 30,
    logFile: '/tmp/voice.log',
    ...overrides,
  } as VoiceConfig;
}

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

describe('summarizeForSpeech', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the rewritten text on success', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('Fixed three bugs. All tests pass.') as never);
    const result = await summarizeForSpeech('a long message', makeConfig());
    expect(result).toBe('Fixed three bugs. All tests pass.');
  });

  it('sends the configured model', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('short') as never);
    await summarizeForSpeech('a long message', makeConfig());
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.model).toBe('gpt-5.4-nano-2026-03-17');
  });

  it('sends the api key as a bearer token', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('short') as never);
    await summarizeForSpeech('a long message', makeConfig());
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('returns null when no openai key is configured', async () => {
    const config = makeConfig({ apiKeys: { openai: null, elevenlabs: 'x' } });
    const result = await summarizeForSpeech('a long message', config);
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns null on a non-200 response', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429, json: async () => ({}) } as never);
    expect(await summarizeForSpeech('a long message', makeConfig())).toBeNull();
  });

  it('returns null when fetch rejects (timeout or network failure)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('The operation was aborted'));
    expect(await summarizeForSpeech('a long message', makeConfig())).toBeNull();
  });

  it('returns null on a malformed response body', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: true }),
    } as never);
    expect(await summarizeForSpeech('a long message', makeConfig())).toBeNull();
  });

  it('returns null on empty content', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('   ') as never);
    expect(await summarizeForSpeech('a long message', makeConfig())).toBeNull();
  });

  it('passes an abort signal so the timeout can fire', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('short') as never);
    await summarizeForSpeech('a long message', makeConfig());
    expect(vi.mocked(fetch).mock.calls[0][1]!.signal).toBeDefined();
  });
});
