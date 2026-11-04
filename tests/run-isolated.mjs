import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitestCli = resolve(projectRoot, 'node_modules/vitest/vitest.mjs');
if (!existsSync(vitestCli)) {
    process.stderr.write('Vitest is not installed. Run npm install before using the isolated test command.\n');
    process.exit(1);
}

// Pass only operating-system paths needed to start Node and MongoDB Memory Server.
// Database/provider credentials and arbitrary shell environment variables are excluded.
const childEnv = {};
const pathValue = process.env.PATH ?? process.env.Path;
if (pathValue) childEnv.PATH = pathValue;
for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[name]) childEnv[name] = process.env[name];
}
Object.assign(childEnv, {
    NODE_ENV: 'test',
    WRITING_XPRESS_ISOLATED_TEST: '1',
});

const child = spawn(process.execPath, [vitestCli, 'run', '--config', 'vitest.config.ts'], {
    cwd: projectRoot,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
});

child.on('error', () => {
    process.stderr.write('Could not start the isolated registration OTP test runner.\n');
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
});
