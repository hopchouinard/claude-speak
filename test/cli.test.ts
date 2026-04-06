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

vi.mock('../src/config.js');
vi.mock('../src/session.js');
vi.mock('../src/extractor.js');
vi.mock('../src/sanitizer.js');
vi.mock('../src/lock.js');
vi.mock('../src/player.js');
vi.mock('../src/error.js');
vi.mock('../src/subcommands.js');

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
    cooldown: 15,
    timeout: 30,
    logFile: '/tmp/voice.log',
    ...overrides,
  };
}

describe('CLI run', () => {
  beforeEach(() => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig());
    vi.mocked(session.loadSession).mockReturnValue({ muted: false });
    vi.mocked(sanitizer.sanitize).mockImplementation((t) => t);
    vi.mocked(lock.isLocked).mockReturnValue(false);
    vi.mocked(lock.writeLock).mockReturnValue(undefined);
    vi.mocked(player.playAudio).mockReturnValue(undefined);
    vi.mocked(error.handleError).mockReturnValue(undefined);
    mockSynthesize.mockResolvedValue(Buffer.from('audio'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits immediately when voice is disabled', async () => {
    vi.mocked(config.loadConfig).mockReturnValue(makeConfig({ enabled: false }));
    await run(['--trigger', 'stop'], '');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('exits silently when muted (--say)', async () => {
    vi.mocked(session.loadSession).mockReturnValue({ muted: true });
    await run(['--say', 'Hello world'], '');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('exits silently when muted (--trigger)', async () => {
    vi.mocked(session.loadSession).mockReturnValue({ muted: true });
    await run(['--trigger', 'stop'], '{}');
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('dispatches --cmd to subcommand handler', async () => {
    vi.mocked(subcommands.dispatch).mockResolvedValue({
      message: 'Voice output muted.',
      speak: false,
    });

    await run(['--cmd', 'mute'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('mute', []);
  });

  it('dispatches --cmd with arguments', async () => {
    vi.mocked(subcommands.dispatch).mockResolvedValue({
      message: 'Speed set to 1.5.',
      speak: false,
    });

    await run(['--cmd', 'speed', '1.5'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('speed', ['1.5']);
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

  it('skips passive voice when lock is active', async () => {
    vi.mocked(lock.isLocked).mockReturnValue(true);
    vi.mocked(extractor.extractMessage).mockReturnValue('Some message');

    await run(['--trigger', 'stop'], '{}');

    expect(mockSynthesize).not.toHaveBeenCalled();
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

  it('allows --cmd through when muted so user can unmute', async () => {
    vi.mocked(session.loadSession).mockReturnValue({ muted: true });
    vi.mocked(subcommands.dispatch).mockResolvedValue({
      message: 'Voice output unmuted.',
      speak: true,
    });

    await run(['--cmd', 'unmute'], '');

    expect(subcommands.dispatch).toHaveBeenCalledWith('unmute', []);
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
