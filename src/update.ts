import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { applySiteManifest, connectWithCode, connectWithLicense, connectWithToken, DEFAULT_BASE_CHANNEL, fetchRelease, isBaseChannel, resolveSite } from './account.ts';
import type { BaseChannel, SiteSession } from './account.ts';
import type { DatabaseAccess, DatabaseSetup } from './database.ts';
import { dumpDatabase, restoreDatabase } from './dump.ts';
import { layoutOf } from './layout.ts';
import type { Layout } from './layout.ts';
import { InstallError, log } from './log.ts';
import { destinationOf } from './manifest.ts';
import type { Manifest, ManifestFile } from './manifest.ts';
import { sha256File } from './net.ts';
import { detectHost } from './platform.ts';
import { sendRcon } from './rcon.ts';
import { readCfgValue } from './servercfg.ts';
import { InstallState, readPrivateJson, writePrivateJson } from './state.ts';
import { missingResources, probeServer, startServer, waitOnline } from './system.ts';
import type { Autostart } from './system.ts';

export type UpdateOptions = {
    dir: string;
    version: string | undefined;
    channel: BaseChannel | undefined;
    site: string | undefined;
    installToken: string | undefined;
    restart: boolean;
    databaseBackup: boolean;
    force: boolean;
};

export type RollbackOptions = {
    dir: string;
    database: boolean;
    restart: boolean;
};

type BackupRecord = {
    format: 1;
    from: string;
    to: string;
    channel: string;
    createdAt: string;
    replaced: string[];
    added: string[];
    removed: string[];
    database: string | null;
    previousManifest: boolean;
    rolledBackAt?: string;
};

type LocalSecrets = { rconPassword?: string; database?: DatabaseSetup };

const MANIFEST_FILE = 'manifest.json';
const BACKUPS_DIR = 'backups';
const BACKUP_RECORD = 'backup.json';
const BACKUP_FILES = 'files';
const DATABASE_FILE = 'database.sql';
const KEEP_BACKUPS = 5;
const DEFAULT_GAME_PORT = 30120;
const PROGRESS_EVERY_SECONDS = 15;
const SHUTDOWN_WAIT_MS = 30_000;
const SHUTDOWN_POLL_MS = 1_000;
const CORE_READY_WAIT_MS = 120_000;
const CORE_READY_POLL_MS = 2_000;

function compareVersions(a: string, b: string): number {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let index = 0; index < 3; index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

export function savedManifestPath(layout: Layout): string {
    return path.join(layout.praxDir, MANIFEST_FILE);
}

export function saveInstalledManifest(layout: Layout, manifest: Manifest): void {
    fs.mkdirSync(layout.praxDir, { recursive: true });
    fs.writeFileSync(savedManifestPath(layout), JSON.stringify(manifest) + '\n');
}

function readInstalledManifest(layout: Layout): Manifest | null {
    const file = savedManifestPath(layout);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
}

function readServerCfg(layout: Layout): string {
    if (!fs.existsSync(layout.serverCfg)) throw new InstallError(`server.cfg introuvable dans ${layout.data}.`, 'Lance prax update depuis le dossier du serveur, ou indique-le avec --dir.');
    return fs.readFileSync(layout.serverCfg, 'utf8');
}

function gamePortOf(cfg: string): number {
    const endpoint = readCfgValue(cfg, 'endpoint_add_tcp') ?? '';
    const port = Number(endpoint.split(':').pop());
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_GAME_PORT;
}

export function parseConnectionString(value: string): DatabaseAccess | null {
    if (!value) return null;
    if (/^mysql:\/\//i.test(value)) {
        const url = new URL(value);
        return {
            host: url.hostname,
            port: Number(url.port) || 3306,
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            database: url.pathname.replace(/^\//, ''),
            tls: url.searchParams.has('ssl'),
        };
    }
    const pairs = new Map<string, string>();
    for (const part of value.split(';')) {
        const index = part.indexOf('=');
        if (index > 0) pairs.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
    }
    const host = pairs.get('server') ?? pairs.get('host');
    const database = pairs.get('database');
    const user = pairs.get('userid') ?? pairs.get('user') ?? pairs.get('uid');
    if (!host || !database || !user) return null;
    return { host, port: Number(pairs.get('port')) || 3306, user, password: pairs.get('password') ?? pairs.get('pwd') ?? '', database };
}

function databaseAccess(layout: Layout, cfg: string): DatabaseAccess | null {
    const secrets = readPrivateJson<LocalSecrets>(layout.localSecrets);
    if (secrets?.database?.server) return secrets.database.server;
    return parseConnectionString(readCfgValue(cfg, 'set mysql_connection_string') ?? '');
}

async function connect(options: UpdateOptions, cfg: string): Promise<SiteSession> {
    const site = resolveSite(options.site);
    const token = options.installToken ?? process.env.PRAX_INSTALL_TOKEN;
    if (token) return connectWithToken(site, token);
    const key = (readCfgValue(cfg, 'set px:license') ?? '').trim().toUpperCase();
    const secret = (readCfgValue(cfg, 'set px:license_secret') ?? '').trim();
    if (key && secret) return connectWithLicense(site, key, secret);
    log.info('Pas de licence dans server.cfg : connexion par code, à entrer sur la page Installer du site.');
    return connectWithCode(site);
}

function backupRoot(layout: Layout): string {
    return path.join(layout.praxDir, BACKUPS_DIR);
}

function listBackups(layout: Layout): string[] {
    const root = backupRoot(layout);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root)
        .filter((name) => fs.existsSync(path.join(root, name, BACKUP_RECORD)))
        .sort();
}

function readRecord(layout: Layout, name: string): BackupRecord {
    return JSON.parse(fs.readFileSync(path.join(backupRoot(layout), name, BACKUP_RECORD), 'utf8')) as BackupRecord;
}

function pruneBackups(layout: Layout): void {
    const backups = listBackups(layout);
    for (const name of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
        fs.rmSync(path.join(backupRoot(layout), name), { recursive: true, force: true });
    }
}

function copyInto(source: string, target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}

async function planChanges(layout: Layout, next: Manifest, previous: Manifest | null) {
    const replaced: ManifestFile[] = [];
    const added: ManifestFile[] = [];
    for (const entry of next.files) {
        const destination = destinationOf(layout, entry.path);
        if (!fs.existsSync(destination)) {
            added.push(entry);
            continue;
        }
        if (entry.preserve) continue;
        if ((await sha256File(destination)) !== entry.sha256) replaced.push(entry);
    }
    const kept = new Set(next.files.map((entry) => entry.path));
    const removed = (previous?.files ?? []).filter((entry) => !entry.preserve && !kept.has(entry.path) && fs.existsSync(destinationOf(layout, entry.path)));
    return { replaced, added, removed };
}

async function waitCoreReady(port: number): Promise<boolean> {
    const deadline = Date.now() + CORE_READY_WAIT_MS;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/pcore/panel/api/branding`, { signal: AbortSignal.timeout(2_000) });
            if (response.ok) return true;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
            continue;
        }
        await new Promise((resolve) => setTimeout(resolve, CORE_READY_POLL_MS));
    }
    return false;
}

async function waitOffline(port: number, limitMs: number): Promise<boolean> {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
        if (!(await probeServer(port, 1_000))) return true;
        await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
    }
    return false;
}

function isGameProcess(executable: string, commandLine: string, fxserverDir: string): boolean {
    const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
    return normalize(executable).startsWith(normalize(fxserverDir)) && /\+exec\s/.test(commandLine);
}

function gameProcesses(layout: Layout): number[] {
    if (process.platform === 'win32') {
        const script = "Get-CimInstance Win32_Process -Filter \"Name='FXServer.exe'\" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ExecutablePath, $_.CommandLine }";
        const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
        return output.split(/\r?\n/).flatMap((line) => {
            const [pid, executable = '', ...rest] = line.split('|');
            return pid && isGameProcess(executable, rest.join('|'), layout.fxserver) ? [Number(pid)] : [];
        });
    }
    return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
        try {
            const parts = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
            const executable = fs.readlinkSync(`/proc/${name}/exe`);
            return isGameProcess(executable, parts.join(' '), layout.fxserver) ? [Number(name)] : [];
        } catch {
            return [];
        }
    });
}

function stopGameProcesses(layout: Layout): number {
    const pids = gameProcesses(layout);
    for (const pid of pids) {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
        else process.kill(pid, 'SIGINT');
    }
    return pids.length;
}

async function stopServer(layout: Layout, port: number, password: string | null): Promise<boolean> {
    if (!(await probeServer(port))) return false;
    if (password) {
        const answer = await sendRcon(port, password, 'quit').catch((error: Error) => error.message);
        if (!/rcon_password|Invalid password|ne répond pas/i.test(answer) && (await waitOffline(port, SHUTDOWN_WAIT_MS))) return true;
    }
    const stopped = stopGameProcesses(layout);
    if (stopped === 0) {
        log.warn('Ni RCON (coupé par txAdmin) ni le processus du serveur de jeu ne sont accessibles.');
        return false;
    }
    log.info(process.platform === 'win32' ? 'RCON indisponible (txAdmin le coupe) : serveur de jeu arrêté directement.' : 'RCON indisponible : serveur de jeu arrêté proprement (SIGINT).');
    if (await waitOffline(port, SHUTDOWN_WAIT_MS)) return true;
    log.warn('Le serveur ne s\'est pas arrêté dans les 30 secondes.');
    return false;
}

async function restartAndCheck(layout: Layout, state: InstallState, cfg: string, rollbackHint: boolean): Promise<void> {
    log.step('Redémarrage');
    const port = gamePortOf(cfg);
    const secrets = readPrivateJson<LocalSecrets>(layout.localSecrets);
    const password = secrets?.rconPassword ?? readCfgValue(cfg, 'rcon_password');
    const wasOnline = await probeServer(port);
    if (!wasOnline) {
        log.info('Le serveur ne tourne pas : la nouvelle version servira à son prochain démarrage.');
        return;
    }
    const stopped = await stopServer(layout, port, password);
    if (!stopped) {
        log.warn('Redémarre le serveur toi-même (txAdmin ou console) pour charger la nouvelle version.');
        return;
    }
    const managedByTxAdmin = state.isDone('txadmin');
    if (!managedByTxAdmin) {
        const host = detectHost();
        const script = path.join(layout.root, host.target === 'windows' ? 'start.bat' : 'start.sh');
        const machine = state.details('machine');
        const autostart: Autostart | null = machine.autostartKind ? { kind: machine.autostartKind as Autostart['kind'], name: machine.autostartName ?? '' } : null;
        startServer(layout, host.target, script, autostart);
    } else {
        log.info('txAdmin relance le serveur.');
    }
    let lastReport = 0;
    const info = await waitOnline(port, (elapsed) => {
        if (elapsed - lastReport < PROGRESS_EVERY_SECONDS) return;
        lastReport = elapsed;
        log.info(`… toujours en démarrage (${elapsed} s)`);
    });
    if (info && missingResources(info).length === 0) {
        log.ok(`Serveur en ligne sur le port ${port} : pcore et pguard lancés`);
        if (await waitCoreReady(port)) {
            log.ok('Base prête : licence vérifiée et clé de la version reçue');
            return;
        }
        log.warn('pcore est lancé mais la base n\'a pas fini de démarrer après 2 minutes (licence, clé de la version ou panel coupé ?).');
        if (rollbackHint) log.info('Regarde sa console. Pour revenir à la version précédente : prax update --rollback');
        return;
    }
    log.warn(info ? `Le serveur répond, mais ${missingResources(info).join(' et ')} n'a pas démarré.` : `Le serveur ne répond pas sur le port ${port}.`);
    if (rollbackHint) log.info('Regarde sa console. Pour revenir à la version précédente : prax update --rollback');
}

export async function runUpdate(options: UpdateOptions): Promise<void> {
    const layout = layoutOf(options.dir);
    const state = new InstallState(layout.state);
    if (!state.isDone('base')) throw new InstallError(`Aucune base Prax installée par prax dans ${layout.root}.`, 'Indique le dossier du serveur avec --dir, ou installe-la avec prax install.');
    const base = state.details('base');
    const current = base.version ?? '0.0.0';
    const channel: BaseChannel = options.channel ?? (isBaseChannel(base.channel) ? base.channel : DEFAULT_BASE_CHANNEL);
    const cfg = readServerCfg(layout);

    log.title(`Mise à jour de la base Prax dans ${layout.root}`);
    log.info(`Version installée : ${current} (canal ${channel})`);
    const session = await connect(options, cfg);

    log.step('Base Prax');
    const manifest = await fetchRelease(session, options.version, channel);
    if (manifest.version === current && !options.force) {
        log.ok(`Déjà à jour : ${current} est la dernière version du canal ${channel}.`);
        return;
    }
    if (compareVersions(manifest.version, current) < 0 && !options.version) {
        throw new InstallError(`La dernière version du canal ${channel} (${manifest.version}) est plus ancienne que la tienne (${current}).`, 'Change de canal avec --channel, ou choisis une version précise avec --version.');
    }
    if (compareVersions(manifest.version, current) < 0) log.warn(`Retour à une version plus ancienne : ${current} → ${manifest.version}.`);

    const previous = readInstalledManifest(layout);
    const changes = await planChanges(layout, manifest, previous);
    log.info(`${changes.replaced.length} fichier(s) changé(s), ${changes.added.length} nouveau(x), ${changes.removed.length} retiré(s).`);
    if (!previous) log.info('Liste des fichiers de l\'ancienne version inconnue (installée avant prax 0.3) : les fichiers retirés de la base resteront en place.');

    log.step('Sauvegarde');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(backupRoot(layout), `${stamp}_${current}`);
    const filesDir = path.join(backupDir, BACKUP_FILES);
    for (const entry of [...changes.replaced, ...changes.removed]) copyInto(destinationOf(layout, entry.path), path.join(filesDir, ...entry.path.split('/')));
    if (previous) copyInto(savedManifestPath(layout), path.join(backupDir, MANIFEST_FILE));
    log.ok(`${changes.replaced.length + changes.removed.length} fichier(s) de la ${current} copiés dans ${path.relative(layout.root, backupDir)}`);

    let databaseFile: string | null = null;
    if (options.databaseBackup) {
        const access = databaseAccess(layout, cfg);
        if (!access) {
            log.warn('Connexion à la base introuvable (mysql_connection_string) : pas d\'export de la base.');
        } else {
            const target = path.join(backupDir, DATABASE_FILE);
            const result = await dumpDatabase(access, target);
            databaseFile = DATABASE_FILE;
            log.ok(`Base « ${access.database} » exportée : ${result.tables} tables, ${result.rows} lignes (${(result.bytes / 1024 / 1024).toFixed(1)} Mo)`);
        }
    } else {
        log.skip('Export de la base sauté (--no-db-backup)');
    }

    const record: BackupRecord = {
        format: 1,
        from: current,
        to: manifest.version,
        channel,
        createdAt: new Date().toISOString(),
        replaced: changes.replaced.map((entry) => entry.path),
        added: changes.added.map((entry) => entry.path),
        removed: changes.removed.map((entry) => entry.path),
        database: databaseFile,
        previousManifest: previous !== null,
    };
    writePrivateJson(path.join(backupDir, BACKUP_RECORD), record);

    log.step(`Installation de la ${manifest.version}`);
    await applySiteManifest(layout, session, manifest);
    for (const entry of changes.removed) fs.rmSync(destinationOf(layout, entry.path), { force: true });
    if (changes.removed.length > 0) log.ok(`${changes.removed.length} fichier(s) retiré(s) de la base supprimé(s)`);
    saveInstalledManifest(layout, manifest);
    const details: Record<string, string> = { ...base, version: manifest.version, channel, previous: current };
    if (manifest.commit) details.commit = manifest.commit;
    state.markDone('base', details);
    pruneBackups(layout);
    log.ok(`Base ${current} → ${manifest.version}. pconfig, server.cfg et txAdmin n'ont pas été touchés.`);

    if (options.restart) await restartAndCheck(layout, state, cfg, true);
    else log.info('Redémarre le serveur pour charger la nouvelle version.');
}

export async function runRollback(options: RollbackOptions): Promise<void> {
    const layout = layoutOf(options.dir);
    const state = new InstallState(layout.state);
    const latest = listBackups(layout).filter((name) => !readRecord(layout, name).rolledBackAt).at(-1);
    if (!latest) throw new InstallError(`Aucune sauvegarde dans ${backupRoot(layout)}.`, 'prax update --rollback ne revient qu\'après une mise à jour faite par prax update.');
    const backupDir = path.join(backupRoot(layout), latest);
    const record = readRecord(layout, latest);
    const cfg = readServerCfg(layout);
    const base = state.details('base');

    log.title(`Retour de la base Prax ${record.to} à la ${record.from}`);
    if (base.version && base.version !== record.to) {
        throw new InstallError(`La sauvegarde la plus récente revient de la ${record.to}, mais la base installée est la ${base.version}.`, 'Refais la mise à jour voulue avec prax update --version.');
    }

    log.step('Fichiers');
    const filesDir = path.join(backupDir, BACKUP_FILES);
    for (const relative of record.added) fs.rmSync(destinationOf(layout, relative), { force: true });
    for (const relative of [...record.replaced, ...record.removed]) copyInto(path.join(filesDir, ...relative.split('/')), destinationOf(layout, relative));
    const previousManifest = path.join(backupDir, MANIFEST_FILE);
    if (record.previousManifest && fs.existsSync(previousManifest)) fs.copyFileSync(previousManifest, savedManifestPath(layout));
    else fs.rmSync(savedManifestPath(layout), { force: true });
    log.ok(`${record.replaced.length + record.removed.length} fichier(s) remis, ${record.added.length} fichier(s) ajouté(s) par la ${record.to} retiré(s)`);

    if (options.database) {
        log.step('Base de données');
        if (!record.database) throw new InstallError('Cette sauvegarde ne contient pas d\'export de la base.');
        const access = databaseAccess(layout, cfg);
        if (!access) throw new InstallError('Connexion à la base introuvable (mysql_connection_string).');
        const port = gamePortOf(cfg);
        if (await probeServer(port)) throw new InstallError('Le serveur tourne encore : arrête-le avant de remettre la base.', 'Sinon, les joueurs connectés écriraient pendant la restauration.');
        const statements = await restoreDatabase(access, path.join(backupDir, record.database));
        log.ok(`Base « ${access.database} » remise à l'état d'avant la mise à jour (${statements} instructions)`);
    } else if (record.database) {
        log.info(`La base n'a pas été touchée. Son export d'avant la mise à jour : ${path.relative(layout.root, path.join(backupDir, record.database))} (prax update --rollback --database pour la remettre, serveur arrêté).`);
    }

    state.markDone('base', { ...base, version: record.from, channel: record.channel, previous: record.to });
    writePrivateJson(path.join(backupDir, BACKUP_RECORD), { ...record, rolledBackAt: new Date().toISOString() });
    log.ok(`Base remise en ${record.from}.`);
    if (options.database) log.info('Relance le serveur (txAdmin ou script de démarrage).');
    else if (options.restart) await restartAndCheck(layout, state, cfg, false);
}
