import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SessionState {
  muted: boolean;
}

export const SESSION_DEFAULTS: SessionState = {
  muted: false,
};

export function getSessionPath(): string {
  return path.join(os.homedir(), '.claude-speak', 'session.json');
}

export function loadSession(): SessionState {
  const sessionPath = getSessionPath();

  if (!fs.existsSync(sessionPath)) {
    return { ...SESSION_DEFAULTS };
  }

  try {
    const raw = fs.readFileSync(sessionPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed.muted !== 'boolean') {
      fs.unlinkSync(sessionPath);
      return { ...SESSION_DEFAULTS };
    }

    return { muted: parsed.muted };
  } catch {
    try {
      fs.unlinkSync(sessionPath);
    } catch {
      // Best effort cleanup
    }
    return { ...SESSION_DEFAULTS };
  }
}

export function writeSession(state: SessionState): void {
  const sessionPath = getSessionPath();
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2), 'utf-8');
}

export function clearSession(): void {
  const sessionPath = getSessionPath();
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}
