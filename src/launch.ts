import fs from 'node:fs';
import path from 'node:path';
import type { Layout } from './layout.ts';
import { log } from './log.ts';
import type { Target } from './platform.ts';

export type LaunchOptions = {
    target: Target;
    withTxAdmin: boolean;
    txAdminPort: number;
    forcedGamePort: number | null;
};

function windowsScript(options: LaunchOptions): string {
    const lines = ['@echo off', 'setlocal', 'cd /d "%~dp0"'];
    if (options.withTxAdmin) {
        lines.push('set "TXHOST_DATA_PATH=%~dp0txData"', `set "TXHOST_TXA_PORT=${options.txAdminPort}"`);
        if (options.forcedGamePort) lines.push(`set "TXHOST_FXS_PORT=${options.forcedGamePort}"`);
        lines.push('"%~dp0server\\FXServer.exe"');
    } else {
        lines.push('cd /d "%~dp0data"', '"%~dp0server\\FXServer.exe" +exec server.cfg');
    }
    return lines.join('\r\n') + '\r\n';
}

function linuxScript(options: LaunchOptions): string {
    const lines = ['#!/bin/sh', 'set -e', 'ROOT="$(cd "$(dirname "$0")" && pwd)"'];
    if (options.withTxAdmin) {
        lines.push('export TXHOST_DATA_PATH="$ROOT/txData"', `export TXHOST_TXA_PORT=${options.txAdminPort}`);
        if (options.forcedGamePort) lines.push(`export TXHOST_FXS_PORT=${options.forcedGamePort}`);
        lines.push('cd "$ROOT/server"', 'exec ./run.sh');
    } else {
        lines.push('cd "$ROOT/data"', 'exec "$ROOT/server/run.sh" +exec server.cfg');
    }
    return lines.join('\n') + '\n';
}

export function writeLaunchScript(layout: Layout, options: LaunchOptions): string {
    const isWindows = options.target === 'windows';
    const file = path.join(layout.root, isWindows ? 'start.bat' : 'start.sh');
    fs.writeFileSync(file, isWindows ? windowsScript(options) : linuxScript(options), { mode: 0o755 });
    log.ok(`Script de démarrage : ${path.basename(file)}`);
    return file;
}
