import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Playback state is machine-global, not per-session: there is one audio
 * device, and a stop request must silence whatever is playing regardless of
 * which session started it.
 */
function stateDir(): string {
  return path.join(os.homedir(), '.claude-speak');
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

export function playAudio(audio: Buffer, command: string): void {
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
        JSON.stringify({ pid: child.pid, startedAt: Date.now() }, null, 2),
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
 * The epoch is stamped before the kill so that a synthesis finishing in the
 * same instant still observes the stop request and discards its audio.
 */
export function stopPlayback(): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(getStopEpochPath(), String(Date.now()), 'utf-8');
  } catch {
    // Best effort.
  }

  const filePath = getPlaybackPath();
  if (!fs.existsSync(filePath)) return;

  try {
    const { pid } = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { pid?: number };
    if (typeof pid === 'number') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ESRCH: the process already exited. Nothing to do.
      }
    }
  } catch {
    // Corrupt pid file: fall through to cleanup.
  }

  clearPlaybackFile();
}

export function readStopEpoch(): number {
  const filePath = getStopEpochPath();
  if (!fs.existsSync(filePath)) return 0;
  try {
    const value = Number(fs.readFileSync(filePath, 'utf-8'));
    return Number.isNaN(value) ? 0 : value;
  } catch {
    return 0;
  }
}
