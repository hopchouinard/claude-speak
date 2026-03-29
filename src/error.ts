import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function handleError(error: unknown, logFile: string): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ERROR: ${message}\n`;

    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, logEntry);
  } catch {
    // If logging fails, we still try the beep
  }

  try {
    if (process.platform === 'darwin') {
      spawnSync('afplay', ['/System/Library/Sounds/Basso.aiff']);
    } else {
      spawnSync('paplay', ['/usr/share/sounds/freedesktop/stereo/dialog-error.oga']);
    }
  } catch {
    // If beep fails, nothing more we can do
  }
}
