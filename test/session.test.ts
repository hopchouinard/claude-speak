import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:os');

describe('session state', () => {
  const mockHome = '/mock/home';
  const sessionPath = '/mock/home/.claude-speak/session.json';

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe('loadSession', () => {
    it('returns defaults when session file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { loadSession } = await import('../src/session.js');
      const state = loadSession();
      expect(state.muted).toBe(false);
    });

    it('reads muted state from session file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ muted: true }));
      const { loadSession } = await import('../src/session.js');
      const state = loadSession();
      expect(state.muted).toBe(true);
    });

    it('returns defaults when muted field is not a boolean', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ muted: 'yes' }));
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
      const { loadSession } = await import('../src/session.js');
      const state = loadSession();
      expect(state.muted).toBe(false);
      expect(fs.unlinkSync).toHaveBeenCalledWith(sessionPath);
    });

    it('deletes corrupted session file and returns defaults', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
      const { loadSession } = await import('../src/session.js');
      const state = loadSession();
      expect(state.muted).toBe(false);
      expect(fs.unlinkSync).toHaveBeenCalledWith(sessionPath);
    });
  });

  describe('writeSession', () => {
    it('writes session state to file', async () => {
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      const { writeSession } = await import('../src/session.js');
      writeSession({ muted: true });
      expect(fs.mkdirSync).toHaveBeenCalledWith('/mock/home/.claude-speak', { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        sessionPath,
        JSON.stringify({ muted: true }, null, 2),
        'utf-8',
      );
    });
  });

  describe('clearSession', () => {
    it('deletes session file if it exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
      const { clearSession } = await import('../src/session.js');
      clearSession();
      expect(fs.unlinkSync).toHaveBeenCalledWith(sessionPath);
    });

    it('does nothing if session file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { clearSession } = await import('../src/session.js');
      clearSession();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });
});
