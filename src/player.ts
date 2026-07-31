import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Playback state is machine-global, not per-session: there is one audio
 * device, and a stop request must silence whatever is playing regardless of
 * which session started it.
 *
 * The stop *epoch* is a different matter. Killing audible audio machine-wide
 * is what the user asked for; discarding audio that has not started playing
 * yet is not, because the pipeline that produced it belongs to some other
 * window and would simply lose its message with no retry. So the epoch record
 * carries the session that stamped it, and `readStopEpoch(sessionId)` only
 * reports stops that apply to the asking session. A record with no session
 * (`!shutup`) is deliberately global — that one is a panic button.
 */
function stateDir(): string {
  return path.join(os.homedir(), '.claude-speak');
}

export interface PlaybackState {
  pid: number;
  startedAt: number;
  sessionId: string | null;
}

interface StopRecord {
  epoch: number;
  sessionId: string | null;
}

export function getPlaybackPath(): string {
  return path.join(stateDir(), 'playback.json');
}

export function getStopEpochPath(): string {
  return path.join(stateDir(), 'stop-epoch');
}

function clearPlaybackFile(): void {
  const filePath = getPlaybackPath();
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best effort.
  }
}

export function readPlaybackState(): PlaybackState | null {
  const filePath = getPlaybackPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
    };
  } catch {
    return null;
  }
}

/**
 * SIGTERM whatever stream is currently tracked and forget it. Machine-global
 * by design; stamps no epoch, so it never discards anyone's pending audio.
 */
export function killTrackedPlayback(): void {
  const state = readPlaybackState();
  if (state) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // ESRCH: the process already exited. Nothing to do.
    }
  }
  clearPlaybackFile();
}

export function playAudio(audio: Buffer, command: string, sessionId: string | null = null): void {
  // One audio device, one stream. Spawning over a live stream would overwrite
  // its pid in playback.json and leave it unaddressable — `!shutup` could then
  // only silence the newest stream while the older one played on.
  killTrackedPlayback();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-speak-'));
  const filePath = path.join(tmpDir, 'output.mp3');
  fs.writeFileSync(filePath, audio);

  const child = spawn(command, [filePath], {
    detached: true,
    stdio: 'ignore',
  });

  if (child.pid) {
    try {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(
        getPlaybackPath(),
        JSON.stringify({ pid: child.pid, startedAt: Date.now(), sessionId }, null, 2),
        'utf-8',
      );
    } catch {
      // Losing the pid file only costs interruptibility, not playback.
    }
  }

  child.on('exit', () => {
    clearPlaybackFile();
    try {
      fs.unlinkSync(filePath);
      fs.rmdirSync(tmpDir);
    } catch {
      // best effort cleanup
    }
  });

  child.unref();
}

/**
 * Silence any in-flight playback.
 *
 * `scopeSessionId` decides who the *discard* half of the stop applies to:
 *
 * - `null` — a global stop (`!shutup`). Every session's pending audio is
 *   discarded as well as the audible stream killed. The user asked the
 *   machine to be quiet and does not care which window is talking.
 * - a session id — a scoped stop (`turn-start`). Audible audio is still
 *   killed machine-wide, but only that session's pending audio is discarded.
 *   One window's prompt submission must not silently swallow another
 *   window's end-of-turn message, which is never retried.
 *
 * The epoch is stamped before the kill so that a synthesis finishing in the
 * same instant still observes the stop request and discards its audio.
 */
export function stopPlayback(scopeSessionId: string | null = null): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(
      getStopEpochPath(),
      JSON.stringify({ epoch: Date.now(), sessionId: scopeSessionId }),
      'utf-8',
    );
  } catch {
    // Best effort.
  }

  killTrackedPlayback();
}

function readStopRecord(): StopRecord | null {
  const filePath = getStopEpochPath();
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    // A bare number is the 1.x/pre-fix format: no session attribution, so it
    // is treated as global.
    if (typeof parsed === 'number') return { epoch: parsed, sessionId: null };
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (typeof record.epoch === 'number') {
        return {
          epoch: record.epoch,
          sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
        };
      }
    }
  } catch {
    // Fall through: unparseable contents mean no stop.
  }
  return null;
}

/**
 * Timestamp of the most recent stop that applies to `forSessionId`.
 *
 * Omit the argument (or pass null) when the caller cannot attribute itself to
 * a session: it then sees every stop, which is the conservative direction —
 * silence over unwanted speech.
 */
export function readStopEpoch(forSessionId?: string | null): number {
  const record = readStopRecord();
  if (!record) return 0;
  if (!forSessionId) return record.epoch;
  if (record.sessionId && record.sessionId !== forSessionId) return 0;
  return record.epoch;
}
