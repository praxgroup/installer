import fs from 'node:fs';
import path from 'node:path';
import { layoutOf } from './layout.ts';
import type { Layout } from './layout.ts';
import { InstallError, log } from './log.ts';
import { readCfgValue } from './servercfg.ts';
import { InstallState, writePrivateJson } from './state.ts';
import { runRollback, runUpdate } from './update.ts';

export const AUTO_USAGE = `prax auto <on|off|status> [--dir <dossier>] : mise à jour automatique de la base

  on       autorise la base à lancer prax quand elle veut se mettre à jour :
             - au démarrage du serveur, si une nouvelle version est sortie et que personne n'est connecté ;
             - tout de suite pour une version urgente, après un compte à rebours en jeu si des joueurs sont là.
           prax sauvegarde, met à jour, relance le serveur, et revient à la version d'avant si la base ne démarre pas.
           Il copie prax dans .prax/bin et ajoute « add_unsafe_child_process_permission pcore » à server.cfg :
           redémarre le serveur une fois pour que FXServer le prenne en compte.
  off      retire l'autorisation donnée à la base
  status   état, dernière mise à jour automatique et fin du journal (.prax/auto.log)

Réglages côté base : Config.Updates (applyOnRestart, urgentRestart, urgentCountdownMinutes) et la commande /pxupdate.`;

type UpdateRequest = { version?: unknown; from?: unknown; reason?: unknown; requestedAt?: unknown };
type UpdaterSettings = { bin: string; args: string[]; root: string; prax: string; enabledAt: string };

const CORE = 'pcore';
const CORE_CACHE = [CORE, 'cache'];
const SETTINGS_FILE = 'updater.json';
const REQUEST_FILE = 'update-request.json';
const RESULT_FILE = 'update-result.json';
const LOG_FILE = 'auto.log';
const LOCK_FILE = 'auto.lock';
const BIN_DIR = 'bin';
const PERMISSION_LINE = `add_unsafe_child_process_permission ${CORE}`;
const PERMISSION_PATTERN = new RegExp(`^\\s*add_unsafe_child_process_permission\\s+"?${CORE}"?\\s*$`);
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

function isCompiled(): boolean {
    return !/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath));
}

function installedCommand(layout: Layout): { bin: string; args: string[] } {
    if (!isCompiled()) return { bin: process.execPath, args: [path.resolve(process.argv[1] ?? '')] };
    const target = path.join(layout.praxDir, BIN_DIR, path.basename(process.execPath));
    if (path.resolve(process.execPath) !== path.resolve(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(process.execPath, target);
        if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    }
    return { bin: target, args: [] };
}

export function hasChildProcessPermission(cfg: string): boolean {
    return cfg.replace(/\r\n/g, '\n').split('\n').some((line) => PERMISSION_PATTERN.test(line));
}

export function withChildProcessPermission(cfg: string): string {
    if (hasChildProcessPermission(cfg)) return cfg;
    const newline = cfg.includes('\r\n') ? '\r\n' : '\n';
    const lines = cfg.split(/\r?\n/);
    const firstEnsure = lines.findIndex((line) => /^\s*(ensure|start)\s+/.test(line));
    if (firstEnsure < 0) return `${cfg.replace(/\s*$/, '')}${newline}${PERMISSION_LINE}${newline}`;
    lines.splice(firstEnsure, 0, PERMISSION_LINE);
    return lines.join(newline);
}

function withoutChildProcessPermission(cfg: string): string {
    const newline = cfg.includes('\r\n') ? '\r\n' : '\n';
    return cfg.split(/\r?\n/).filter((line) => !PERMISSION_PATTERN.test(line)).join(newline);
}

function requireBase(layout: Layout): InstallState {
    const state = new InstallState(layout.state);
    if (!state.isDone('base')) throw new InstallError(`Aucune base Prax installée par prax dans ${layout.root}.`, 'Indique le dossier du serveur avec --dir.');
    return state;
}

function readServerCfg(layout: Layout): string {
    if (!fs.existsSync(layout.serverCfg)) throw new InstallError(`server.cfg introuvable dans ${layout.data}.`);
    return fs.readFileSync(layout.serverCfg, 'utf8');
}

export function enableAuto(dir: string, praxVersion: string): void {
    const layout = layoutOf(dir);
    const state = requireBase(layout);
    log.title(`Mise à jour automatique de la base Prax dans ${layout.root}`);
    const cfg = readServerCfg(layout);
    if (!(readCfgValue(cfg, 'set px:license') ?? '').trim() || !(readCfgValue(cfg, 'set px:license_secret') ?? '').trim()) {
        log.warn('server.cfg n\'a pas px:license et px:license_secret : prax ne pourra pas se connecter au site tant qu\'ils manquent.');
    }
    const command = installedCommand(layout);
    const settings: UpdaterSettings = { bin: command.bin, args: command.args, root: layout.root, prax: praxVersion, enabledAt: new Date().toISOString() };
    writeJson(path.join(cacheDir(layout), SETTINGS_FILE), settings);
    const shown = command.bin.startsWith(layout.root + path.sep) ? path.relative(layout.root, command.bin) : command.bin;
    log.ok(`La base lancera ${shown} pour se mettre à jour`);
    const permitted = hasChildProcessPermission(cfg);
    if (!permitted) {
        fs.copyFileSync(layout.serverCfg, `${layout.serverCfg}.bak`);
        fs.writeFileSync(layout.serverCfg, withChildProcessPermission(cfg));
        log.ok(`server.cfg : « ${PERMISSION_LINE} » ajouté (ancien fichier en server.cfg.bak)`);
    } else {
        log.skip(`server.cfg a déjà « ${PERMISSION_LINE} »`);
    }
    state.markDone(STEP, { bin: command.bin, prax: praxVersion });
    log.ok('La base demandera les mises à jour au démarrage du serveur, et tout de suite pour une version urgente.');
    if (!permitted) log.warn('Redémarre le serveur une fois : FXServer ne lit cette autorisation qu\'au démarrage.');
    log.info('Journal : .prax/auto.log · état : prax auto status · arrêt : prax auto off');
    if (isCompiled()) log.info('Après une nouvelle version de prax, relance prax auto on pour que la base l\'utilise.');
}

export function disableAuto(dir: string): void {
    const layout = layoutOf(dir);
    const state = requireBase(layout);
    fs.rmSync(path.join(cacheDir(layout), SETTINGS_FILE), { force: true });
    fs.rmSync(path.join(cacheDir(layout), REQUEST_FILE), { force: true });
    const cfg = readServerCfg(layout);
    if (hasChildProcessPermission(cfg)) {
        fs.writeFileSync(layout.serverCfg, withoutChildProcessPermission(cfg));
        log.ok(`server.cfg : « ${PERMISSION_LINE} » retiré`);
    }
    state.reset(STEP);
    log.ok('Mise à jour automatique coupée. La base affiche de nouveau les versions sans les poser.');
}

export function autoStatus(dir: string): void {
    const layout = layoutOf(dir);
    requireBase(layout);
    log.title(`Mise à jour automatique dans ${layout.root}`);
    const settings = readJson<UpdaterSettings>(path.join(cacheDir(layout), SETTINGS_FILE));
    const cfg = readServerCfg(layout);
    if (!settings) {
        log.info('Pas en place : prax auto on pour l\'activer.');
    } else {
        (fs.existsSync(settings.bin) ? log.ok : log.warn)(`prax lancé par la base : ${settings.bin}${fs.existsSync(settings.bin) ? '' : ' (introuvable : relance prax auto on)'}`);
        (hasChildProcessPermission(cfg) ? log.ok : log.warn)(hasChildProcessPermission(cfg) ? `server.cfg autorise pcore à lancer prax` : `server.cfg n'a pas « ${PERMISSION_LINE} » : relance prax auto on`);
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

export async function runAuto(dir: string): Promise<number> {
    const layout = layoutOf(dir);
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
        const message = (error as Error).message;
        log.fail(`Mise à jour automatique en échec : ${message}`);
        writeJson(resultFile, { ok: false, version: version ?? current, from: current, at: startedAt, error: message.slice(0, 300) });
        return 1;
    } finally {
        fs.rmSync(path.join(layout.praxDir, LOCK_FILE), { force: true });
    }
}
