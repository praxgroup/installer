import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
execFileSync('git', ['config', 'core.hooksPath', 'tools/git-hooks'], { cwd: root, stdio: 'inherit' });
execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, stdio: 'inherit' });
console.log('Hooks git installés (tools/git-hooks) : audit à chaque commit et à chaque push.');
