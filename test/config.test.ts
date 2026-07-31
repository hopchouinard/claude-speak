import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');

describe('loadConfig', () => {
  const mockHome = '/mock/home';

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns defaults when no config file exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.activeProvider).toBe('openai');
    expect(config.providers.openai.model).toBe('gpt-4o-mini-tts-2025-12-15');
    expect(config.providers.openai.voice).toBe('ash');
    expect(config.enabled).toBe(false);
  });

  it('loads new nested config format', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      activeProvider: 'elevenlabs',
      providers: {
        elevenlabs: {
          model: 'eleven_multilingual_v2',
          voice: 'Rachel',
          speed: 1.0,
          stability: 0.7,
          similarityBoost: 0.8,
          style: 0.1,
        },
      },
    }));
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.activeProvider).toBe('elevenlabs');
    expect(config.providers.elevenlabs.voice).toBe('Rachel');
    expect(config.providers.elevenlabs.stability).toBe(0.7);
    expect(config.providers.elevenlabs.similarityBoost).toBe(0.8);
    expect(config.providers.elevenlabs.style).toBe(0.1);
    expect(config.enabled).toBe(true);
  });

  it('auto-migrates old flat format', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'nova',
      speed: 1.2,
    }));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.activeProvider).toBe('openai');
    expect(config.providers.openai.voice).toBe('nova');
    expect(config.providers.openai.speed).toBe(1.2);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('continues in memory if migration write fails', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o-mini-tts-2025-12-15',
      voice: 'echo',
      speed: 1.0,
    }));
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.activeProvider).toBe('openai');
    expect(config.providers.openai.voice).toBe('echo');
    expect(config.error).toBeUndefined();
  });

  it('respects CLAUDE_SPEAK_ENABLED=false env override', async () => {
    vi.stubEnv('CLAUDE_SPEAK_ENABLED', 'false');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      activeProvider: 'openai',
      providers: { openai: { model: 'gpt-4o-mini-tts-2025-12-15', voice: 'ash', speed: 1.0 } },
    }));
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.enabled).toBe(false);
  });

  it('reads OpenAI API key from CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY env', async () => {
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY', 'sk-test-key');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.apiKeys.openai).toBe('sk-test-key');
  });

  it('reads ElevenLabs API key from ELEVENLABS_API_KEY env', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'el-test-key');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.apiKeys.elevenlabs).toBe('el-test-key');
  });

  it('handles malformed config file gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.enabled).toBe(false);
    expect(config.error).toBe('malformed-config');
  });

  describe('speech config', () => {
    it('supplies speech defaults when no config file exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig();
      expect(config.speech.maxChars).toBe(500);
      expect(config.speech.condense).toBe(true);
      expect(config.speech.summarizer.model).toBe('gpt-5.4-nano-2026-03-17');
      expect(config.speech.summarizer.timeout).toBe(8);
      expect(config.speech.summarizer.maxWords).toBe(40);
    });

    it('overrides speech defaults from the config file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          activeProvider: 'openai',
          providers: { openai: { model: 'm', voice: 'ash', speed: 1 } },
          speech: { maxChars: 200, condense: false },
        }),
      );
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig();
      expect(config.speech.maxChars).toBe(200);
      expect(config.speech.condense).toBe(false);
    });

    it('merges a partial summarizer block over its defaults', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          activeProvider: 'openai',
          providers: { openai: { model: 'm', voice: 'ash', speed: 1 } },
          speech: { summarizer: { timeout: 3 } },
        }),
      );
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig();
      expect(config.speech.summarizer.timeout).toBe(3);
      expect(config.speech.summarizer.model).toBe('gpt-5.4-nano-2026-03-17');
      expect(config.speech.summarizer.maxWords).toBe(40);
    });

    function loadWithSpeech(speech: unknown) {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          activeProvider: 'openai',
          providers: { openai: { model: 'm', voice: 'ash', speed: 1 } },
          speech,
        }),
      );
      return import('../src/config.js').then((m) => m.loadConfig());
    }

    // The documented way to disable condensation is `"condense": false`. A
    // string "false" is not nullish, so `??` would keep it — and a non-empty
    // string is truthy, leaving condensation ON for someone trying to turn it
    // off. That is the failure this guards.
    it('ignores a string "false" for condense rather than treating it as truthy', async () => {
      const config = await loadWithSpeech({ condense: 'false' });
      expect(config.speech.condense).toBe(true);
    });

    it('still honours a real boolean false for condense', async () => {
      const config = await loadWithSpeech({ condense: false });
      expect(config.speech.condense).toBe(false);
    });

    it('ignores a string maxChars and keeps the numeric default', async () => {
      const config = await loadWithSpeech({ maxChars: '200' });
      expect(config.speech.maxChars).toBe(500);
      expect(typeof config.speech.maxChars).toBe('number');
    });

    it('ignores a NaN maxChars, which would make every threshold comparison false', async () => {
      const config = await loadWithSpeech({ maxChars: Number.NaN });
      expect(config.speech.maxChars).toBe(500);
    });

    it('ignores an empty-string summarizer model', async () => {
      const config = await loadWithSpeech({ summarizer: { model: '' } });
      expect(config.speech.summarizer.model).toBe('gpt-5.4-nano-2026-03-17');
    });

    it('ignores a non-object speech block instead of throwing', async () => {
      const config = await loadWithSpeech('yes');
      expect(config.speech.maxChars).toBe(500);
      expect(config.speech.condense).toBe(true);
    });

    it('ignores an array speech block', async () => {
      const config = await loadWithSpeech([]);
      expect(config.speech.condense).toBe(true);
    });

    it('ignores a non-object summarizer block', async () => {
      const config = await loadWithSpeech({ summarizer: 42 });
      expect(config.speech.summarizer.timeout).toBe(8);
    });
  });

  // hooks.json sources ~/.claude-speak/env before invoking the CLI; the speak
  // skill does not. A key kept only in that file therefore reached the passive
  // path and nothing else, so active voice and every speaking subcommand died
  // with "No API key" — silent apart from an error beep.
  describe('api keys from ~/.claude-speak/env', () => {
    const ENV_PATH = '/mock/home/.claude-speak/env';

    function withEnvFile(contents: string | null) {
      vi.mocked(fs.existsSync).mockReturnValue(false); // no ~/.claude-speak.json
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === ENV_PATH) {
          if (contents === null) throw new Error('ENOENT');
          return contents;
        }
        throw new Error('ENOENT');
      });
      return import('../src/config.js').then((m) => m.loadConfig());
    }

    beforeEach(() => {
      delete process.env.ELEVENLABS_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.CLAUDE_PLUGIN_OPTION_ELEVENLABS_API_KEY;
      delete process.env.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY;
    });

    it('reads a key the process environment does not have', async () => {
      const config = await withEnvFile('ELEVENLABS_API_KEY=el-from-file\n');
      expect(config.apiKeys.elevenlabs).toBe('el-from-file');
    });

    it('handles the export form', async () => {
      const config = await withEnvFile('export OPENAI_API_KEY=sk-exported\n');
      expect(config.apiKeys.openai).toBe('sk-exported');
    });

    it('strips surrounding double and single quotes', async () => {
      const config = await withEnvFile(
        'OPENAI_API_KEY="sk-double"\nELEVENLABS_API_KEY=\'el-single\'\n',
      );
      expect(config.apiKeys.openai).toBe('sk-double');
      expect(config.apiKeys.elevenlabs).toBe('el-single');
    });

    it('skips comments and blank lines', async () => {
      const config = await withEnvFile('# OPENAI_API_KEY=sk-commented\n\nELEVENLABS_API_KEY=el-real\n');
      expect(config.apiKeys.openai).toBeNull();
      expect(config.apiKeys.elevenlabs).toBe('el-real');
    });

    it('does not let a trailing comment leak into an unquoted value', async () => {
      const config = await withEnvFile('ELEVENLABS_API_KEY=el-real # my key\n');
      expect(config.apiKeys.elevenlabs).toBe('el-real');
    });

    it('lets the process environment win over the file', async () => {
      process.env.ELEVENLABS_API_KEY = 'el-from-env';
      const config = await withEnvFile('ELEVENLABS_API_KEY=el-from-file\n');
      expect(config.apiKeys.elevenlabs).toBe('el-from-env');
    });

    it('lets the plugin keychain option win over both', async () => {
      process.env.ELEVENLABS_API_KEY = 'el-from-env';
      process.env.CLAUDE_PLUGIN_OPTION_ELEVENLABS_API_KEY = 'el-from-keychain';
      const config = await withEnvFile('ELEVENLABS_API_KEY=el-from-file\n');
      expect(config.apiKeys.elevenlabs).toBe('el-from-keychain');
    });

    it('returns null keys when the file is absent', async () => {
      const config = await withEnvFile(null);
      expect(config.apiKeys.openai).toBeNull();
      expect(config.apiKeys.elevenlabs).toBeNull();
    });

    it('ignores an empty assignment rather than storing an empty key', async () => {
      const config = await withEnvFile('ELEVENLABS_API_KEY=\n');
      expect(config.apiKeys.elevenlabs).toBeNull();
    });

    it('does not execute the file', async () => {
      // The file is sourced by a shell elsewhere. Evaluating it here would run
      // arbitrary code on every CLI start.
      const config = await withEnvFile('ELEVENLABS_API_KEY=$(rm -rf /)\n');
      expect(config.apiKeys.elevenlabs).toBe('$(rm');
    });
  });
});
