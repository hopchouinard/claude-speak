import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { run, isIdleNotification } from '../src/cli.js';
import * as config from '../src/config.js';
import * as session from '../src/session.js';
import * as extractor from '../src/extractor.js';
import * as sanitizer from '../src/sanitizer.js';
import * as lock from '../src/lock.js';
import * as player from '../src/player.js';
import * as error from '../src/error.js';
import * as subcommands from '../src/subcommands.js';
import * as condenser from '../src/condenser.js';
import * as summarizer from '../src/summarizer.js';

vi.mock('../src/config.js');
vi.mock('../src/session.js');
vi.mock('../src/extractor.js');
vi.mock('../src/sanitizer.js');
vi.mock('../src/lock.js');
vi.mock('../src/player.js');
vi.mock('../src/error.js');
vi.mock('../src/subcommands.js');
vi.mock('../src/condenser.js');
vi.mock('../src/summarizer.js');

// Mock the TTS provider factory
const mockSynthesize = vi.fn();
vi.mock('../src/tts/factory.js', () => ({
  createProvider: () => ({ synthesize: mockSynthesize }),
}));

function makeConfig(overrides: Partial<config.VoiceConfig> = {}): config.VoiceConfig {
  return {
    enabled: true,
    activeProvider: 'openai',
    providers: {
      openai: {
        model: 'gpt-4o-mini-tts-2025-12-15',
        voice: 'ash',
        speed: 1.0,
      },
      elevenlabs: {
        model: 'eleven_multilingual_v2',
        voice: '',
        speed: 1.0,
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0.0,
      },
    },
    apiKeys: {
      openai: 'sk-test',
      elevenlabs: null,
    },
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
  };
}

// Declared at file scope so every describe block below inherits the baseline
// mocks. Nested describes do not inherit a sibling describe's beforeEach.
beforeEach(() => {
  vi.mocked(config.loadConfig).mockReturnValue(makeConfig());
  vi.mocked(session.resolveSessionId).mockReturnValue('sess-1');
  vi.mocked(session.isActive).mockReturnValue(true);
  vi.mocked(session.consumeSpokeThisTurn).mockReturnValue(false);
  vi.mocked(session.consumeSilencedThisTurn).mockReturnValue(false);
  vi.mocked(condenser.shouldCondense).mockReturnValue(false);
  vi.mocked(player.readStopEpoch).mockReturnValue(0);
  vi.mocked(sanitizer.sanitize).mockImplementation((t) => t);
  vi.mocked(lock.isLocked).mockReturnValue(false);
  vi.mocked(lock.writeLock).mockReturnValue(undefined);
  vi.mocked(player.playAudio).mockReturnValue(undefined);
  vi.mocked(error.handleError).mockReturnValue(undefined);
  mockSynthesize.mockResolvedValue(Buffer.from('audio'));
  // --cmd writes its result to stdout; keep it out of the test report.
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI run', () => {
  it('exits immediately when voice is disabled', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({ enabled: false }));
    await run(['--trigger', 'stop'], '');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('exits silently when the session is not active (--say)', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    await run(['--say', 'Hello world'], '');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('exits silently when the session is not active (--trigger)', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    await run(['--trigger', 'stop'], '{}');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('dispatches --cmd to subcommand handler', async () => {
    vi.mocked(subcommands.dispatch).mockResolvedValue({
      message: 'Voice output muted.',
      speak: false,
    });

    await run(['--cmd', 'mute'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('mute', [], 'sess-1');
  });

  it('dispatches --cmd with arguments', async () => {
    vi.mocked(subcommands.dispatch).mockResolvedValue({
      message: 'Speed set to 1.5.',
      speak: false,
    });

    await run(['--cmd', 'speed', '1.5'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('speed', ['1.5'], 'sess-1');
  });

  it('processes --say argument through the pipeline', async () => {
    await run(['--say', 'Hello world'], '');

    expect(sanitizer.sanitize).toHaveBeenCalledWith('Hello world');
    expect(mockSynthesize).toHaveBeenCalled();
    expect(player.playAudio).toHaveBeenCalled();
  });

  it('writes lock when using --say (active voice)', async () => {
    await run(['--say', 'Hello'], '');
    expect(lock.writeLock).toHaveBeenCalled();
  });

  it('processes --trigger by extracting from stdin', async () => {
    const stdinData = JSON.stringify({
      message: { role: 'assistant', content: 'Done with the task.' },
    });
    vi.mocked(extractor.extractMessage).mockReturnValue('Done with the task.');

    await run(['--trigger', 'stop'], stdinData);

    expect(extractor.extractMessage).toHaveBeenCalledWith(stdinData);
    expect(sanitizer.sanitize).toHaveBeenCalledWith('Done with the task.');
    expect(mockSynthesize).toHaveBeenCalled();
  });

  it('skips passive voice when lock is active (notification trigger)', async () => {
    vi.mocked(lock.isLocked).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('Some message');

    await run(['--trigger', 'notification'], '{}');

    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('ignores the cooldown lock on a stop trigger, which dedups per turn instead', async () => {
    vi.mocked(lock.isLocked).mockReturnValue(true);
    vi.mocked(session.consumeSpokeThisTurn).mockReturnValue(false);
    vi.mocked(session.consumeSilencedThisTurn).mockReturnValue(false);
  vi.mocked(session.consumeSilencedThisTurn).mockReturnValue(false);
    vi.mocked(extractor.extractMessage).mockReturnValue('Some message');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).toHaveBeenCalled();
  });

  it('skips when hook type is disabled in config', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({
      hooks: { stop: false, notification: true },
    }));
    vi.mocked(extractor.extractMessage).mockReturnValue('Some message');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('calls error handler on TTS failure', async () => {
    mockSynthesize.mockRejectedValue(new Error('API down'));

    await run(['--say', 'Hello'], '');

    expect(error.handleError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.any(String)
    );
  });

  it('exits when no API key for active provider', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({
      apiKeys: { openai: null, elevenlabs: null },
    }));

    await run(['--say', 'Hello'], '');

    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(error.handleError).toHaveBeenCalled();
  });

  it('filters idle notifications on notification trigger', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('Claude is waiting for your input');

    await run(['--trigger', 'notification'], '{}');

    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('allows non-idle notifications on notification trigger', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('Build completed successfully');

    await run(['--trigger', 'notification'], '{}');

    expect(mockSynthesize).toHaveBeenCalled();
  });

  it('does not filter idle-like text on stop trigger', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('I am waiting for your input on the design.');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).toHaveBeenCalled();
  });

  it('speaks the unmute confirmation even though voice was off when the command arrived', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    vi.mocked(subcommands.dispatch).mockImplementation(async () => {
      // handleOn calls activate() before returning, so the session is already
      // active by the time cli.ts checks the gate for the confirmation.
      vi.mocked(session.isActive).mockReturnValue(true);
      return { message: 'Voice output unmuted.', speak: true };
    });

    await run(['--cmd', 'unmute'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('unmute', [], 'sess-1');
    expect(mockSynthesize).toHaveBeenCalled();
  });

  it('does not speak for --cmd test when voice is off', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    vi.mocked(subcommands.dispatch).mockResolvedValue({
      message: 'Voice check.',
      speak: true,
    });

    await run(['--cmd', 'test'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('test', [], 'sess-1');
    // test has speak: true but the session is not active, so no speech
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('outputs usage when --cmd has no subcommand', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await run(['--cmd'], '');

    expect(subcommands.dispatch).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    // The list must name the command that turns the feature on, or a mistyped
    // subcommand leaves the user with no way to discover it.
    const usage = stdoutSpy.mock.calls[0][0] as string;
    expect(usage).toMatch(/\bon\b/);
    expect(usage).toMatch(/\boff\b/);
    stdoutSpy.mockRestore();
  });
});

describe('activation gate', () => {
  it('speaks nothing on a stop trigger when the session is inactive', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).not.toHaveBeenCalled();
  });

  it('speaks nothing on active voice when the session is inactive', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);

    await run(['--say', 'hello'], '');

    expect(player.playAudio).not.toHaveBeenCalled();
  });

  it('routes --cmd even when the session is inactive, so voice can be turned on', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: 'ok', speak: false });

    await run(['--cmd', 'on'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('on', [], 'sess-1');
  });

  it('routes --cmd stop even when the session is inactive', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: '', speak: false });

    await run(['--cmd', 'stop'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('stop', [], 'sess-1');
  });

  it('does not speak a subcommand confirmation while voice is off', async () => {
    vi.mocked(session.isActive).mockReturnValue(false);
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: 'a test phrase', speak: true });

    await run(['--cmd', 'test'], '');

    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('speaks a subcommand confirmation once voice is active', async () => {
    vi.mocked(session.isActive).mockReturnValue(true);
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: 'a test phrase', speak: true });

    await run(['--cmd', 'test'], '');

    expect(mockSynthesize).toHaveBeenCalledWith('a test phrase', expect.anything());
  });
});

describe('condensation', () => {
  it('uses the LLM rewrite when the message is over threshold', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('a very long message with a table');
    vi.mocked(condenser.shouldCondense).mockReturnValue(true);
    vi.mocked(summarizer.summarizeForSpeech).mockResolvedValue('Two bugs fixed.');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).toHaveBeenCalledWith('Two bugs fixed.', expect.anything());
  });

  it('falls back to the heuristic when the rewrite returns null', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('a very long message with a table');
    vi.mocked(condenser.shouldCondense).mockReturnValue(true);
    vi.mocked(summarizer.summarizeForSpeech).mockResolvedValue(null);
    vi.mocked(condenser.heuristicCondense).mockReturnValue('Finished.');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).toHaveBeenCalledWith('Finished.', expect.anything());
  });

  it('leaves a short message untouched', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('Done.');
    vi.mocked(condenser.shouldCondense).mockReturnValue(false);

    await run(['--trigger', 'stop'], '{}');

    expect(summarizer.summarizeForSpeech).not.toHaveBeenCalled();
    expect(mockSynthesize).toHaveBeenCalledWith('Done.', expect.anything());
  });

  it('never condenses active voice text', async () => {
    vi.mocked(condenser.shouldCondense).mockReturnValue(true);

    await run(['--say', 'A hand written line.'], '');

    expect(summarizer.summarizeForSpeech).not.toHaveBeenCalled();
    expect(mockSynthesize).toHaveBeenCalledWith('A hand written line.', expect.anything());
  });

  it('speaks a fallback line when the heuristic condenses the message to nothing', async () => {
    // A message that is only a table or only a code fence strips to empty.
    // Silence there is a regression from 1.x, which read something aloud.
    vi.mocked(extractor.extractMessage).mockReturnValue('| a | b |\n|---|---|\n| 1 | 2 |');
    vi.mocked(condenser.shouldCondense).mockReturnValue(true);
    vi.mocked(summarizer.summarizeForSpeech).mockResolvedValue(null);
    vi.mocked(condenser.heuristicCondense).mockReturnValue('');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    const spoken = mockSynthesize.mock.calls[0][0] as string;
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken).toMatch(/screen/i);
    expect(player.playAudio).toHaveBeenCalled();
  });

  it('skips condensation entirely when disabled in config', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({
      speech: {
        maxChars: 500,
        condense: false,
        summarizer: { model: 'm', timeout: 8, maxWords: 40 },
      },
    }));
    vi.mocked(extractor.extractMessage).mockReturnValue('a very long message');
    vi.mocked(condenser.shouldCondense).mockReturnValue(true);

    await run(['--trigger', 'stop'], '{}');

    expect(summarizer.summarizeForSpeech).not.toHaveBeenCalled();
    expect(mockSynthesize).toHaveBeenCalledWith('a very long message', expect.anything());
  });
});

describe('stop during synthesis', () => {
  it('discards audio when a stop was requested after synthesis began', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');
    // Synthesis resolves, but a stop landed while it was in flight.
    mockSynthesize.mockImplementation(async () => {
      vi.mocked(player.readStopEpoch).mockReturnValue(Date.now() + 1000);
      return Buffer.from('audio');
    });

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).not.toHaveBeenCalled();
  });

  it('plays audio when no stop was requested', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');
    vi.mocked(player.readStopEpoch).mockReturnValue(0);

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).toHaveBeenCalled();
  });

  it('discards audio when a stop lands during synthesis on the subcommand path', async () => {
    // Pins the second, deliberately duplicated stop guard in speakText().
    // Without it this path plays audio the user already asked to silence.
    vi.mocked(subcommands.dispatch).mockResolvedValue({
      message: 'a test phrase',
      speak: true,
    });
    mockSynthesize.mockImplementation(async () => {
      vi.mocked(player.readStopEpoch).mockReturnValue(Date.now() + 1000);
      return Buffer.from('audio');
    });

    await run(['--cmd', 'test'], '');

    expect(mockSynthesize).toHaveBeenCalled();
    expect(player.playAudio).not.toHaveBeenCalled();
  });
});

describe('per-session stop scoping', () => {
  it('scopes the stop-epoch check to this session', async () => {
    // A prompt submitted in another window stamps the machine-global epoch.
    // Reading it unscoped would silently discard this window's narration.
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');

    expect(player.readStopEpoch).toHaveBeenCalledWith('sess-1');
  });

  it('records the owning session when it starts playback', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).toHaveBeenCalledWith(expect.any(Buffer), 'afplay', 'sess-1');
  });

  it('scopes the stop-epoch check on the subcommand path too', async () => {
    vi.mocked(subcommands.dispatch).mockResolvedValue({
      message: 'a test phrase',
      speak: true,
    });

    await run(['--cmd', 'test'], '');

    expect(player.readStopEpoch).toHaveBeenCalledWith('sess-1');
    expect(player.playAudio).toHaveBeenCalledWith(expect.any(Buffer), 'afplay', 'sess-1');
  });
});


describe('garbage collection', () => {
  it('collects stale session state even when voice is disabled', async () => {
    // GC must not sit behind the kill switch: a user with enabled=false would
    // otherwise accumulate session files forever and never lose the legacy
    // 1.x session.json.
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({ enabled: false }));
    vi.mocked(subcommands.dispatch).mockResolvedValue({ message: '', speak: false });

    await run(['--cmd', 'gc'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('gc', [], 'sess-1');
  });
});

// Fake timers, because the whole point is that measurable time passes between
// the moment the request is stamped and the moment synthesis starts.
describe('stop during condensation', () => {
  const base = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(base);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('discards audio when a stop lands while the summarizer is still in flight', async () => {
    vi.mocked(extractor.extractMessage).mockReturnValue('a very long message with a table');
    vi.mocked(condenser.shouldCondense).mockReturnValue(true);
    vi.mocked(summarizer.summarizeForSpeech).mockImplementation(async () => {
      // The summarizer blocks for five seconds. One second in, the user gives
      // up and hits stop — long before synthesis is ever reached.
      vi.mocked(player.readStopEpoch).mockReturnValue(base + 1000);
      vi.setSystemTime(base + 5000);
      return 'Two bugs fixed.';
    });

    await run(['--trigger', 'stop'], '{}');

    // Condensation ran to completion and synthesis was attempted...
    expect(mockSynthesize).toHaveBeenCalledWith('Two bugs fixed.', expect.anything());
    // ...but the audio is thrown away, because the stop predates the request.
    expect(player.playAudio).not.toHaveBeenCalled();
  });

  it('plays audio when the stop epoch predates the request, as at turn start', async () => {
    // The UserPromptSubmit hook stamps the stop epoch when the turn begins,
    // which is always older than a request stamped later in the same turn. An
    // earlier stamp must not make a turn swallow its own end-of-turn message.
    vi.mocked(player.readStopEpoch).mockReturnValue(base - 1000);
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).toHaveBeenCalled();
  });
});

describe('turn-scoped dedup', () => {
  it('suppresses the stop hook when active voice already spoke this turn', async () => {
    vi.mocked(session.consumeSpokeThisTurn).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).not.toHaveBeenCalled();
  });

  it('speaks on the stop hook when nothing spoke this turn', async () => {
    vi.mocked(session.consumeSpokeThisTurn).mockReturnValue(false);
    vi.mocked(session.consumeSilencedThisTurn).mockReturnValue(false);
  vi.mocked(session.consumeSilencedThisTurn).mockReturnValue(false);
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).toHaveBeenCalled();
  });

  it('speaks on a second consecutive stop hook, since the flag was consumed', async () => {
    vi.mocked(session.consumeSpokeThisTurn).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(extractor.extractMessage).mockReturnValue('hello');

    await run(['--trigger', 'stop'], '{}');
    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).toHaveBeenCalledTimes(1);
  });

  it('marks the turn as spoken on active voice', async () => {
    await run(['--say', 'hello'], '');
    expect(session.setSpokeThisTurn).toHaveBeenCalledWith('sess-1', true);
  });

  it('still uses the cooldown lock for notification triggers', async () => {
    vi.mocked(lock.isLocked).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('a notification');

    await run(['--trigger', 'notification'], '{}');

    expect(player.playAudio).not.toHaveBeenCalled();
  });
});

describe('isIdleNotification', () => {
  it.each([
    'Claude is waiting for your input',
    'Waiting for input',
    'waiting for your response',
    'Ready for your next input',
    'Awaiting your input',
    'Claude is waiting for input.',
  ])('detects idle notification: %s', (text) => {
    expect(isIdleNotification(text)).toBe(true);
  });

  it.each([
    'I need your input on the database schema',
    'Build completed successfully',
    'The tests are waiting to be reviewed',
    'I updated the config file',
  ])('allows legitimate message: %s', (text) => {
    expect(isIdleNotification(text)).toBe(false);
  });
});

// !shutup stopped the narration and the Stop hook then spoke Claude's one-word
// reply ("Quiet."), so asking for silence produced a new spoken word. Observed
// twice in a real session. Every part behaved correctly in isolation; only the
// interaction was wrong, which is why nothing caught it.
describe('silence after an explicit stop', () => {
  it('does not speak the end-of-turn message when a stop was requested this turn', async () => {
    vi.mocked(session.consumeSilencedThisTurn).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('Quiet.');

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).not.toHaveBeenCalled();
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('consumes the flag so the next turn speaks again', async () => {
    vi.mocked(session.consumeSilencedThisTurn).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('Quiet.');
    await run(['--trigger', 'stop'], '{}');
    expect(session.consumeSilencedThisTurn).toHaveBeenCalledWith('sess-1');

    vi.mocked(session.consumeSilencedThisTurn).mockReturnValue(false);
    vi.mocked(extractor.extractMessage).mockReturnValue('A normal reply.');
    await run(['--trigger', 'stop'], '{}');
    expect(player.playAudio).toHaveBeenCalled();
  });

  it('checks silence before the spoke-this-turn dedup', async () => {
    // Both flags must be consumed on the same turn, or a stop during a turn
    // that also used active voice would leave one set for the next turn.
    vi.mocked(session.consumeSilencedThisTurn).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('Quiet.');

    await run(['--trigger', 'stop'], '{}');

    expect(player.playAudio).not.toHaveBeenCalled();
  });

  it('leaves notification triggers alone', async () => {
    // Silence is turn-scoped and stop-hook-specific; notifications keep using
    // the cooldown lock.
    vi.mocked(session.consumeSilencedThisTurn).mockReturnValue(true);
    vi.mocked(lock.isLocked).mockReturnValue(false);
    vi.mocked(extractor.extractMessage).mockReturnValue('a notification');

    await run(['--trigger', 'notification'], '{}');

    expect(player.playAudio).toHaveBeenCalled();
  });
});
