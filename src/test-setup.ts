import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate signature persistence from the user's real ~/.config/antigravity-proxy/signature-store.json
// before any test file imports signature-cache.js.
if (!process.env.ANTIGRAVITY_SIGNATURE_STORE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-sigstore-'));
    process.env.ANTIGRAVITY_SIGNATURE_STORE = path.join(dir, 'store.json');
    process.once('exit', () => {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup of test temp dir
        }
    });
}
