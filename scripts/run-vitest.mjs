import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Vitest's DOM worker resolves root-relative setup modules from process.cwd().
// A Windows directory junction can otherwise disagree with Vite's real path.
const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const cli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
