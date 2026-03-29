import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
export function playAudio(audio, command) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-speak-'));
    const filePath = path.join(tmpDir, 'output.mp3');
    fs.writeFileSync(filePath, audio);
    const child = spawn(command, [filePath], {
        detached: true,
        stdio: 'ignore',
    });
    child.on('exit', () => {
        try {
            fs.unlinkSync(filePath);
            fs.rmdirSync(tmpDir);
        }
        catch {
            // best effort cleanup
        }
    });
    child.unref();
}
//# sourceMappingURL=player.js.map