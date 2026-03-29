import * as fs from 'node:fs';
import * as path from 'node:path';
export function writeLock(lockPath) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(Date.now()));
}
export function isLocked(lockPath, cooldownSeconds) {
    if (!fs.existsSync(lockPath))
        return false;
    try {
        const raw = fs.readFileSync(lockPath, 'utf-8');
        const timestamp = Number(raw);
        if (Number.isNaN(timestamp))
            return false;
        const elapsed = Date.now() - timestamp;
        return elapsed < cooldownSeconds * 1000;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=lock.js.map