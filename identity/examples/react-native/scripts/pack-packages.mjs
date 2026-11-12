/**
 * Pack the identity package from this repository into ./packages, so the app installs it as npm would install the
 * published package (npm install then picks it up from package.json).
 *
 *   npm run pack-packages && npm install
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('../', import.meta.url));
const identity = fileURLToPath(new URL('../../../', import.meta.url));
const packages = fileURLToPath(new URL('../packages/', import.meta.url));
mkdirSync(packages, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const out = execFileSync(npm, ['pack', '--pack-destination', packages], { cwd: identity, encoding: 'utf8', shell: process.platform === 'win32' });
console.log(`Packed into ${packages}: ${out.trim().split('\n').pop()} (from ${identity}; app in ${here})`);
