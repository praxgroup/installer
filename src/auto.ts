import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { layoutOf } from './layout.ts';
import type { Layout } from './layout.ts';
import { InstallError, log } from './log.ts';
import { detectHost } from './platform.ts';
import type { Target } from './platform.ts';
import { readCfgValue } from './servercfg.ts';
import { InstallState, writePrivateJson } from './state.ts';
import { isElevated, serviceSlug } from './system.ts';
import { runRollback, runUpdate } from './update.ts';

export const AUTO_USAGE = `prax auto <on|off|status> [--dir <dossier>] : mise à jour automatique de la base

  on       installe une tâche qui passe chaque minute (tâche planifiée Windows, minuteur systemd ou cron).
           Elle ne fait rien tant que la base ne demande rien. La base demande une mise à jour :
             - au démarrage du serveur, si une nouvelle version est sortie et que personne n'est connecté ;
             - tout de suite pour une version urgente, après un compte à rebours en jeu si des joueurs sont là.
           La tâche sauvegarde, met à jour, relance le serveur, et revient à la version d'avant si la base ne démarre pas.
  off      retire la tâche
  status   état de la tâche, dernière mise à jour automatique et fin du journal (.prax/auto.log)

Réglages côté base : Config.Updates (applyOnRestart, urgentRestart, urgentCountdownMinutes) et la commande /pxupdate.`;

type Scheduler = { kind: 'schtasks' | 'systemd' | 'cron'; name: string };
type UpdateRequest = { version?: unknown; from?: unknown; reason?: unknown; requestedAt?: unknown };

const CORE_CACHE = ['pcore', 'cache'];
const UPDATER_FILE = 'updater.json';
const REQUEST_FILE = 'update-request.json';
const RESULT_FILE = 'update-result.json';
const LOG_FILE = 'auto.log';
const LOCK_FILE = 'auto.lock';
const BIN_DIR = 'bin';
const LAUNCHER_FILE = 'auto.vbs';
const LOCK_STALE_MS = 60 * 60 * 1000;
const LOG_LIMIT_BYTES = 1024 * 1024;
const LOG_TAIL_LINES = 15;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const STEP = 'auto';

function cacheDir(layout: Layout): string {
    return path.join(layout.resources, ...CORE_CACHE);
}

function readJson<T>(file: string): T | null {
    try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value) + '\n');
}

function compareVersions(a: string, b: string): number {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let index = 0; index < 3; index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

function writeHeartbeat(layout: Layout, praxVersion: string): void {
    if (!fs.existsSync(path.join(layout.resources, 'pcore'))) return;
    writeJson(path.join(cacheDir(layout), UPDATER_FILE), { seenAt: Math.floor(Date.now() / 1000), prax: praxVersion });
}

function isCompiled(): boolean {
    return !/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath));
}

function taskCommand(layout: Layout): string[] {
    if (!isCompiled()) return [process.execPath, path.resolve(process.argv[1] ?? '')];
    const target = path.join(layout.praxDir, BIN_DIR, path.basename(process.execPath));
    if (path.resolve(process.execPath) !== path.resolve(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(process.execPath, target);
        if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    }
    return [target];
}

function taskName(layout: Layout): string {
    return `prax-${serviceSlug(layout)}-auto`.replace(/^prax-prax-/, 'prax-');
}

function windowsLauncher(layout: Layout, command: string[]): string {
    const quoted = [...command, 'auto', 'run', '--dir', layout.root].map((part) => `""${part}""`).join(' ');
    const file = path.join(layout.praxDir, BIN_DIR, LAUNCHER_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const script = `CreateObject("WScript.Shell").Run "${quoted}", 0, False\r\n`;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]));
    return file;
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cronLine(layout: Layout, command: string[]): string {
    return `* * * * * ${[...command, 'auto', 'run', '--dir', layout.root].map(shellQuote).join(' ')} >/dev/null 2>&1`;
}

function readCrontab(): string {
    try {
        return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return '';
    }
}

function writeCrontab(content: string): void {
    execFileSync('crontab', ['-'], { input: content, stdio: ['pipe', 'ignore', 'ignore'] });
}

function cronMarker(layout: Layout): string {
    return ` 'auto' 'run' '--dir' ${shellQuote(layout.root)}`;
}

function hasCommand(command: string): boolean {
    try {
        execFileSync(command, ['--version'], { stdio: 'ignore' });
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
}

function installScheduler(layout: Layout, target: Target, command: string[]): Scheduler {
    const elevated = isElevated(target);
    if (target === 'windows') {
        const name = `Prax\\${taskName(layout)}`;
        const launcher = windowsLauncher(layout, command);
        const args = ['/Create', '/TN', name, '/TR', `wscript.exe //B //Nologo "${launcher}"`, '/SC', 'MINUTE', '/MO', '1', '/F'];
        if (elevated) args.push('/RU', 'SYSTEM', '/RL', 'HIGHEST');
        execFileSync('schtasks', args, { stdio: 'ignore', windowsHide: true });
        log.ok(`Tâche planifiée « ${name} » : passe chaque minute${elevated ? ', même sans session ouverte' : ''}`);
        if (!elevated) log.info('Sans droits administrateur, la tâche ne tourne que quand ta session Windows est ouverte. Relance prax auto on en administrateur pour qu\'elle tourne toujours.');
        return { kind: 'schtasks', name };
    }
    if (elevated && fs.existsSync('/run/systemd/system')) {
        const name = taskName(layout);
        const user = process.env.SUDO_USER && process.env.SUDO_USER !== 'root' ? process.env.SUDO_USER : 'root';
        const exec = [...command, 'auto', 'run', '--dir', layout.root].map((part) => `"${part}"`).join(' ');
        fs.writeFileSync(`/etc/systemd/system/${name}.service`, ['[Unit]', 'Description=Mise à jour automatique de la base Prax', '', '[Service]', 'Type=oneshot', `User=${user}`, `WorkingDirectory=${layout.root}`, `ExecStart=${exec}`, ''].join('\n'));
        fs.writeFileSync(`/etc/systemd/system/${name}.timer`, ['[Unit]', 'Description=Mise à jour automatique de la base Prax', '', '[Timer]', 'OnBootSec=60', 'OnUnitActiveSec=60', 'AccuracySec=5', '', '[Install]', 'WantedBy=timers.target', ''].join('\n'));
        execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
        execFileSync('systemctl', ['enable', '--now', `${name}.timer`], { stdio: 'ignore' });
        log.ok(`Minuteur systemd « ${name}.timer » : passe chaque minute, en tant que ${user}`);
        return { kind: 'systemd', name };
    }
    if (!hasCommand('crontab')) {
        throw new InstallError('Ni systemd (avec sudo) ni cron ne sont disponibles pour lancer la tâche.', `Lance chaque minute : ${[...command, 'auto', 'run', '--dir', layout.root].join(' ')}`);
    }
    const marker = cronMarker(layout);
    const kept = readCrontab().split('\n').filter((line) => line.trim() && !line.includes(marker));
    writeCrontab([...kept, cronLine(layout, command), ''].join('\n'));
    log.ok('Tâche cron ajoutée : passe chaque minute');
    return { kind: 'cron', name: layout.root };
}

function removeScheduler(layout: Layout, scheduler: Scheduler): void {
    if (scheduler.kind === 'schtasks') {
        try {
            execFileSync('schtasks', ['/Delete', '/TN', scheduler.name, '/F'], { stdio: 'ignore', windowsHide: true });
        } catch {
            log.warn(`Tâche « ${scheduler.name} » introuvable ou protégée : supprime-la dans le planificateur de tâches si elle existe encore.`);
        }
        return;
    }
    if (scheduler.kind === 'systemd') {
        execFileSync('systemctl', ['disable', '--now', `${scheduler.name}.timer`], { stdio: 'ignore' });
        fs.rmSync(`/etc/systemd/system/${scheduler.name}.timer`, { force: true });
        fs.rmSync(`/etc/systemd/system/${scheduler.name}.service`, { force: true });
        execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
        return;
    }
    const marker = cronMarker(layout);
    const kept = readCrontab().split('\n').filter((line) => line.trim() && !line.includes(marker));
    writeCrontab(kept.length ? `${kept.join('\n')}\n` : '');
}

function schedulerAlive(scheduler: Scheduler, layout: Layout): boolean {
    try {
        if (scheduler.kind === 'schtasks') {
            execFileSync('schtasks', ['/Query', '/TN', scheduler.name], { stdio: 'ignore', windowsHide: true });
            return true;
        }
        if (scheduler.kind === 'systemd') {
            return execFileSync('systemctl', ['is-active', `${scheduler.name}.timer`], { encoding: 'utf8' }).trim() === 'active';
        }
        return readCrontab().includes(cronMarker(layout));
    } catch {
        return false;
    }
}

function requireBase(layout: Layout): InstallState {
    const state = new InstallState(layout.state);
    if (!state.isDone('base')) throw new InstallError(`Aucune base Prax installée par prax dans ${layout.root}.`, 'Indique le dossier du serveur avec --dir.');
    return state;
}

function savedScheduler(state: InstallState): Scheduler | null {
    const details = state.details(STEP);
    if (details.kind !== 'schtasks' && details.kind !== 'systemd' && details.kind !== 'cron') return null;
    return { kind: details.kind, name: details.name ?? '' };
}

export function enableAuto(dir: string, praxVersion: string): void {
    const layout = layoutOf(dir);
    const state = requireBase(layout);
    const host = detectHost();
    log.title(`Mise à jour automatique de la base Prax dans ${layout.root}`);
    const cfg = fs.existsSync(layout.serverCfg) ? fs.readFileSync(layout.serverCfg, 'utf8') : '';
    if (!(readCfgValue(cfg, 'set px:license') ?? '').trim() || !(readCfgValue(cfg, 'set px:license_secret') ?? '').trim()) {
        log.warn('server.cfg n\'a pas px:license et px:license_secret : la tâche ne pourra pas se connecter au site tant qu\'ils manquent.');
    }
    const previous = savedScheduler(state);
    if (previous) removeScheduler(layout, previous);
    const command = taskCommand(layout);
    const scheduler = installScheduler(layout, host.target, command);
    state.markDone(STEP, { kind: scheduler.kind, name: scheduler.name, command: command.join(' '), prax: praxVersion });
    writeHeartbeat(layout, praxVersion);
    log.ok('La base le voit dès maintenant : elle demandera les mises à jour au démarrage, et tout de suite pour une version urgente.');
    log.info(`Journal : ${path.relative(process.cwd(), path.join(layout.praxDir, LOG_FILE)) || LOG_FILE} · état : prax auto status · arrêt : prax auto off`);
    if (isCompiled()) log.info('Après une nouvelle version de prax, relance prax auto on pour que la tâche l\'utilise.');
}

export function disableAuto(dir: string): void {
    const layout = layoutOf(dir);
    const state = requireBase(layout);
    const scheduler = savedScheduler(state);
    if (!scheduler) {
        log.skip('La mise à jour automatique n\'est pas en place.');
        return;
    }
    removeScheduler(layout, scheduler);
    fs.rmSync(path.join(cacheDir(layout), UPDATER_FILE), { force: true });
    fs.rmSync(path.join(cacheDir(layout), REQUEST_FILE), { force: true });
    state.reset(STEP);
    log.ok('Mise à jour automatique retirée. La base affiche de nouveau les versions sans les poser.');
}

export function autoStatus(dir: string): void {
    const layout = layoutOf(dir);
    const state = requireBase(layout);
    const scheduler = savedScheduler(state);
    log.title(`Mise à jour automatique dans ${layout.root}`);
    if (!scheduler) {
        log.info('Pas en place : prax auto on pour l\'activer.');
    } else {
        const alive = schedulerAlive(scheduler, layout);
        (alive ? log.ok : log.warn)(`Tâche ${scheduler.kind} « ${scheduler.name} » ${alive ? 'active' : 'introuvable : relance prax auto on'}`);
        const heartbeat = readJson<{ seenAt?: number }>(path.join(cacheDir(layout), UPDATER_FILE));
        if (heartbeat?.seenAt) log.info(`Dernier passage : il y a ${Math.max(0, Math.round(Date.now() / 1000 - heartbeat.seenAt))} s`);
    }
    const request = readJson<UpdateRequest>(path.join(cacheDir(layout), REQUEST_FILE));
    if (request?.version) log.info(`Demande en attente : ${String(request.version)} (${String(request.reason ?? '')})`);
    const result = readJson<{ ok?: boolean; version?: string; from?: string; at?: string; error?: string; rolledBack?: boolean }>(path.join(cacheDir(layout), RESULT_FILE));
    if (result) {
        const when = result.at ? new Date(result.at).toLocaleString('fr-FR') : '?';
        if (result.ok) log.ok(`Dernière mise à jour automatique : ${result.from} → ${result.version}, le ${when}`);
        else log.warn(`Dernière mise à jour automatique en échec : ${result.from} → ${result.version}, le ${when}${result.rolledBack ? ', revenue à la version d\'avant' : ''}${result.error ? ` (${result.error})` : ''}`);
    }
    const logFile = path.join(layout.praxDir, LOG_FILE);
    if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-LOG_TAIL_LINES);
        log.step('Fin du journal');
        for (const line of lines) console.log(`  ${line}`);
    }
}

function teeToLog(layout: Layout): void {
    const file = path.join(layout.praxDir, LOG_FILE);
    fs.mkdirSync(layout.praxDir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT_BYTES) fs.renameSync(file, `${file}.1`);
    const write = (args: unknown[]) => {
        const text = args.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
        const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        fs.appendFileSync(file, text.split('\n').map((line) => `${stamp} ${line}`).join('\n') + '\n');
    };
    const out = console.log.bind(console);
    const err = console.error.bind(console);
    console.log = (...args: unknown[]) => {
        out(...args);
        write(args);
    };
    console.error = (...args: unknown[]) => {
        err(...args);
        write(args);
    };
}

function takeLock(layout: Layout): boolean {
    const file = path.join(layout.praxDir, LOCK_FILE);
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < LOCK_STALE_MS) return false;
    writePrivateJson(file, { pid: process.pid, at: new Date().toISOString() });
    return true;
}

export async function runAuto(dir: string, praxVersion: string): Promise<number> {
    const layout = layoutOf(dir);
    writeHeartbeat(layout, praxVersion);
    const requestFile = path.join(cacheDir(layout), REQUEST_FILE);
    const request = readJson<UpdateRequest>(requestFile);
    if (!request) return 0;
    if (!takeLock(layout)) return 0;
    const resultFile = path.join(cacheDir(layout), RESULT_FILE);
    const state = new InstallState(layout.state);
    const current = state.details('base').version ?? '0.0.0';
    const version = typeof request.version === 'string' && VERSION_PATTERN.test(request.version) ? request.version : null;
    const startedAt = new Date().toISOString();
    try {
        teeToLog(layout);
        fs.rmSync(requestFile, { force: true });
        log.title(`Mise à jour automatique demandée par la base (${String(request.reason ?? '?')}) : ${current} → ${version ?? '?'}`);
        if (!version || compareVersions(version, current) <= 0) {
            log.skip(`Demande ignorée : ${version ?? 'version illisible'} n'est pas plus récente que la ${current}.`);
            writeJson(resultFile, { ok: true, version: current, from: current, at: startedAt, skipped: true });
            return 0;
        }
        const result = await runUpdate({ dir, version, channel: undefined, site: undefined, installToken: undefined, restart: true, databaseBackup: true, force: false, unattended: true });
        if (result.ready === false) {
            log.warn(`La base ne démarre pas en ${result.to} : retour automatique à la ${result.from}.`);
            await runRollback({ dir, database: false, restart: true });
            writeJson(resultFile, { ok: false, version: result.to, from: result.from, at: startedAt, rolledBack: true });
            return 1;
        }
        writeJson(resultFile, { ok: true, version: result.to, from: result.from, at: startedAt, ready: result.ready });
        return 0;
    } catch (error) {
        const message = error instanceof InstallError ? error.message : (error as Error).message;
        log.fail(`Mise à jour automatique en échec : ${message}`);
        writeJson(resultFile, { ok: false, version: version ?? current, from: current, at: startedAt, error: message.slice(0, 300) });
        return 1;
    } finally {
        fs.rmSync(path.join(layout.praxDir, LOCK_FILE), { force: true });
    }
}
