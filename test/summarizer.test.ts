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
    vi.useRealTimers();
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

  it('omits temperature and any token-cap parameter from the request body', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse('short') as never);
    await summarizeForSpeech('a long message', makeConfig());
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    // Deliberate: the target model family varies in which of these it
    // accepts, and a rejected parameter would fail every request. A future
    // "helpful" addition of either would break requests against models that
    // reject it, so this must stay pinned.
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
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

  it('aborts and resolves to null once the configured timeout elapses', async () => {
    vi.useFakeTimers();
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    // A fetch that never settles on its own, but rejects like real fetch
    // does when its AbortSignal fires. This exercises the real timer path
    // rather than just asserting a signal object was passed.
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('This operation was aborted'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // makeConfig()'s summarizer.timeout is 8 (seconds); the assertions
    // below are keyed off that value converting to 8000ms.
    const resultPromise = summarizeForSpeech('a long message', makeConfig());

    // Just under the converted timeout (8s -> 8000ms): abort() must not
    // have been invoked yet. This pins the seconds->ms conversion from the
    // short side — if the implementation used the raw seconds value (or any
    // other too-short duration) as the timer delay, abort() would already
    // have fired by now.
    await vi.advanceTimersByTimeAsync(7999);
    expect(abortSpy).not.toHaveBeenCalled();

    // The remaining 1ms crosses the configured 8000ms threshold: abort()
    // must fire and the function must resolve to null.
    await vi.advanceTimersByTimeAsync(1);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it('does not abort a fast successful call and leaves no pending timer', async () => {
    vi.useFakeTimers();
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    vi.mocked(fetch).mockResolvedValue(okResponse('short') as never);

    const result = await summarizeForSpeech('a long message', makeConfig());

    expect(result).toBe('short');
    expect(abortSpy).not.toHaveBeenCalled();
    // clearTimeout in the finally block should have cancelled the pending
    // timer; nothing should be left scheduled.
    expect(vi.getTimerCount()).toBe(0);
  });
});
