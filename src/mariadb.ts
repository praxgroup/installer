import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { formatSql, randomPassword, tcpRunner } from './database.ts';
import type { SqlRunner } from './database.ts';
import type { Layout } from './layout.ts';
import { InstallError, log } from './log.ts';
import { downloadFile, fetchJson, sha256File } from './net.ts';
import { isPortFree } from './platform.ts';

const RELEASES_URL = 'https://downloads.mariadb.org/rest-api/mariadb/';
const DOWNLOAD_HOST = 'downloads.mariadb.org';
const VERSION_MARKER = '.prax-version';
const LOCAL_HOST = '127.0.0.1';
const PORT_CANDIDATES = [3306, 3307, 3308, 3309, 3310, 3311];
const START_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
const SYSTEM_SOCKET_PORT_QUERY = 'SELECT @@port';

export type PortableMariaDb = {
    home: string;
    version: string;
    port: number;
    rootPassword: string;
};

export type PortableBinaries = {
    installDb: string;
    server: string;
    admin: string;
};

type MajorRelease = { release_id: string; release_status: string; release_support_type: string | null };
type ReleaseFile = {
    file_name: string;
    package_type: string;
    os: string | null;
    cpu: string | null;
    checksum: { sha256sum?: string };
    file_download_url: string;
};
type ReleaseList = { releases: Record<string, { release_id: string; files: ReleaseFile[] }> };

export type MariaDbArchive = { version: string; fileName: string; url: string; sha256: string };

export async function resolveMariaDbZip(): Promise<MariaDbArchive> {
    const majors = await fetchJson<{ major_releases: MajorRelease[] }>(RELEASES_URL);
    const lts = majors.major_releases.find((release) => release.release_status === 'Stable' && release.release_support_type === 'Long Term Support');
    if (!lts) throw new InstallError("MariaDB n'a renvoyé aucune version LTS stable.");
    const latest = await fetchJson<ReleaseList>(`${RELEASES_URL}${encodeURIComponent(lts.release_id)}/latest/`);
    const release = Object.values(latest.releases)[0];
    const file = release?.files.find((candidate) => candidate.os === 'Windows' && candidate.cpu === 'x86_64' && candidate.package_type === 'ZIP file' && !/debug/i.test(candidate.file_name));
    if (!release || !file || !file.checksum.sha256sum) throw new InstallError(`Aucune archive Windows trouvée pour MariaDB ${lts.release_id}.`);
    const url = new URL(file.file_download_url);
    url.protocol = 'https:';
    if (url.host !== DOWNLOAD_HOST) throw new InstallError(`Adresse de téléchargement de MariaDB inattendue : ${url.host}.`);
    return { version: release.release_id, fileName: file.file_name, url: url.toString(), sha256: file.checksum.sha256sum.toLowerCase() };
}

function firstExisting(dir: string, names: string[]): string | null {
    for (const name of names) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

export function portableBinaries(home: string): PortableBinaries | null {
    const bin = path.join(home, 'bin');
    const installDb = firstExisting(bin, ['mariadb-install-db.exe', 'mysql_install_db.exe']);
    const server = firstExisting(bin, ['mariadbd.exe', 'mysqld.exe']);
    const admin = firstExisting(bin, ['mariadb-admin.exe', 'mysqladmin.exe']);
    return installDb && server && admin ? { installDb, server, admin } : null;
}

export function portableConfigFile(layout: Layout): string {
    return path.join(layout.mariadbData, 'my.ini');
}

function windowsTar(): string {
    return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

async function downloadPortable(layout: Layout): Promise<{ home: string; version: string }> {
    const home = path.join(layout.mariadb, 'server');
    const archive = await resolveMariaDbZip();
    const marker = path.join(home, VERSION_MARKER);
    if (fs.existsSync(marker) && portableBinaries(home)) {
        const installed = fs.readFileSync(marker, 'utf8').trim();
        log.skip(`MariaDB ${installed} déjà présent`);
        return { home, version: installed };
    }

    const file = path.join(layout.cache, archive.fileName);
    if (!fs.existsSync(file) || (await sha256File(file)) !== archive.sha256) {
        const digest = await downloadFile(archive.url, file, `MariaDB ${archive.version}`);
        if (digest !== archive.sha256) {
            fs.rmSync(file, { force: true });
            throw new InstallError('L\'archive de MariaDB téléchargée ne correspond pas à son empreinte officielle.', 'Relance l\'installation ; si ça recommence, vérifie ta connexion ou ton antivirus.');
        }
    }
    log.ok(`MariaDB ${archive.version} téléchargé et vérifié (sha256 ${archive.sha256.slice(0, 12)}…)`);

    const staging = `${home}.new`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    execFileSync(windowsTar(), ['-xf', file, '-C', staging], { stdio: 'ignore' });
    const inner = fs.readdirSync(staging, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const extracted = inner.length === 1 && inner[0] ? path.join(staging, inner[0].name) : staging;
    if (!portableBinaries(extracted)) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw new InstallError("L'archive de MariaDB ne contient pas les programmes attendus.", `Supprime ${file} et relance l'installation.`);
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.renameSync(extracted, home);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.writeFileSync(path.join(home, VERSION_MARKER), `${archive.version}\n`);
    return { home, version: archive.version };
}

function useLocalCopy(source: string): { home: string; version: string } {
    const home = path.resolve(source);
    const binaries = portableBinaries(home);
    if (!binaries) throw new InstallError(`Aucun MariaDB pour Windows dans ${home}`, 'Indique le dossier extrait du zip officiel (celui qui contient bin\\).');
    const output = execFileSync(binaries.server, ['--version'], { encoding: 'utf8' });
    const version = output.match(/Ver\s+([\d.]+)/)?.[1] ?? 'inconnue';
    log.ok(`MariaDB ${version} pris dans ${home}`);
    return { home, version };
}

async function pickPort(): Promise<number> {
    for (const port of PORT_CANDIDATES) {
        if (await isPortFree(port, false)) return port;
    }
    throw new InstallError(`Aucun port libre pour MariaDB entre ${PORT_CANDIDATES[0]} et ${PORT_CANDIDATES[PORT_CANDIDATES.length - 1]}.`);
}

const FORCED_SETTINGS = ['bind-address=127.0.0.1', 'character-set-server=utf8mb4', 'collation-server=utf8mb4_unicode_ci'];

function settingName(line: string): string {
    return (line.trim().split('=')[0] ?? '').trim().toLowerCase().replace(/_/g, '-');
}

export function restrictToLocalhost(configText: string): string {
    const forcedNames = new Set(FORCED_SETTINGS.map(settingName));
    const lines = configText.replace(/\r\n/g, '\n').split('\n').filter((line) => !forcedNames.has(settingName(line)));
    const section = lines.findIndex((line) => /^\s*\[(mysqld|mariadbd)\]\s*$/i.test(line));
    if (section === -1) return [...lines, '[mysqld]', ...FORCED_SETTINGS, ''].join('\r\n');
    lines.splice(section + 1, 0, ...FORCED_SETTINGS);
    return lines.join('\r\n');
}

function canConnect(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host: LOCAL_HOST, port });
        socket.setTimeout(1000);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', () => resolve(false));
    });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await canConnect(port)) return true;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
}

export async function startPortable(layout: Layout, mariadb: PortableMariaDb): Promise<void> {
    if (await canConnect(mariadb.port)) return;
    const binaries = portableBinaries(mariadb.home);
    if (!binaries) throw new InstallError(`MariaDB introuvable dans ${mariadb.home}`, 'Relance prax install.');
    const child = spawn(binaries.server, [`--defaults-file=${portableConfigFile(layout)}`], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    if (!(await waitForPort(mariadb.port, START_TIMEOUT_MS))) {
        throw new InstallError(`MariaDB ne répond pas sur le port ${mariadb.port} après ${START_TIMEOUT_MS / 1000} s.`, `Regarde le fichier .err dans ${layout.mariadbData}.`);
    }
}

async function secureRoot(port: number, password: string): Promise<void> {
    const runner = await tcpRunner({ host: LOCAL_HOST, port, user: 'root', password: '', tls: false });
    try {
        const accounts = (await runner.query("SELECT User AS user, Host AS host FROM mysql.user WHERE User = 'root'")) as Array<{ user: string; host: string }>;
        for (const account of accounts) await runner.query('ALTER USER ?@? IDENTIFIED BY ?', [account.user, account.host, password]);
        await runner.query("DELETE FROM mysql.user WHERE User = ''");
        await runner.query('FLUSH PRIVILEGES');
    } finally {
        await runner.close();
    }
}

export async function installPortable(layout: Layout, previous: PortableMariaDb | undefined, localCopy: string | undefined): Promise<PortableMariaDb> {
    const { home, version } = localCopy ? useLocalCopy(localCopy) : await downloadPortable(layout);
    const binaries = portableBinaries(home) as PortableBinaries;
    const configFile = portableConfigFile(layout);
    const initialized = fs.existsSync(configFile);

    if (initialized && !previous) {
        throw new InstallError(
            `Une base MariaDB existe déjà dans ${layout.mariadbData}, mais l'installeur n'a pas son mot de passe.`,
            'Supprime ce dossier pour repartir de zéro, ou réponds « create » avec le compte administrateur de cette base.',
        );
    }

    const port = previous?.port ?? (await pickPort());
    const rootPassword = previous?.rootPassword ?? randomPassword();
    const result: PortableMariaDb = { home, version, port, rootPassword };

    if (!initialized) {
        fs.mkdirSync(layout.mariadb, { recursive: true });
        execFileSync(binaries.installDb, [`--datadir=${layout.mariadbData}`, `--port=${port}`, '--silent'], { stdio: 'ignore', windowsHide: true });
        if (!fs.existsSync(configFile)) throw new InstallError(`MariaDB n'a pas créé ${configFile}.`);
        fs.writeFileSync(configFile, restrictToLocalhost(fs.readFileSync(configFile, 'utf8')));
        log.ok(`Base MariaDB créée dans ${path.relative(layout.root, layout.mariadbData)} (port ${port}, accessible seulement depuis cette machine)`);
    }

    await startPortable(layout, result);
    if (!initialized) {
        await secureRoot(port, rootPassword);
        log.ok('Compte administrateur de MariaDB protégé par un mot de passe aléatoire');
    }
    log.ok(`MariaDB ${version} lancé sur 127.0.0.1:${port}`);
    return result;
}

function commandExists(command: string): boolean {
    try {
        execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
    execFileSync(command, args, { stdio: 'inherit', env });
}

function clientCommand(): string | null {
    if (commandExists('mariadb')) return 'mariadb';
    if (commandExists('mysql')) return 'mysql';
    return null;
}

export function isRoot(): boolean {
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

export function installSystemPackage(): void {
    if (!isRoot()) {
        throw new InstallError(
            "L'installation de MariaDB demande les droits root.",
            'Relance avec sudo, ou installe MariaDB toi-même puis réponds « create ».',
        );
    }
    if (clientCommand() && commandExists('mariadbd')) {
        log.skip('MariaDB déjà installé');
    } else if (commandExists('apt-get')) {
        const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
        run('apt-get', ['update'], env);
        run('apt-get', ['install', '-y', 'mariadb-server'], env);
    } else if (commandExists('dnf')) {
        run('dnf', ['install', '-y', 'mariadb-server']);
    } else if (commandExists('yum')) {
        run('yum', ['install', '-y', 'mariadb-server']);
    } else {
        throw new InstallError(
            "Distribution non reconnue : ni apt-get, ni dnf, ni yum.",
            'Installe MariaDB avec le gestionnaire de paquets de ton système, puis relance et réponds « create ».',
        );
    }
    if (commandExists('systemctl')) run('systemctl', ['enable', '--now', 'mariadb']);
    log.ok('MariaDB installé et lancé (service mariadb)');
}

export function socketRunner(): SqlRunner {
    const client = clientCommand();
    if (!client) throw new InstallError('Le client mariadb est introuvable.');
    return {
        tls: false,
        async query(sql, params = []) {
            const output = execFileSync(client, ['--batch', '--skip-column-names', '--protocol=socket', '-uroot'], {
                input: `${formatSql(sql, params)};\n`,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return output.split('\n').filter((line) => line !== '').map((line) => line.split('\t'));
        },
        async close() {},
    };
}

export async function systemPort(runner: SqlRunner): Promise<number> {
    const rows = (await runner.query(SYSTEM_SOCKET_PORT_QUERY)) as string[][];
    const port = Number(rows[0]?.[0]);
    return Number.isInteger(port) && port > 0 ? port : 3306;
}

export const DATABASE_SCRIPT = 'start-mariadb.bat';

function powershellLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function hiddenStartLine(server: string, config: string): string {
    const argument = `('--defaults-file=' + [char]34 + ${powershellLiteral(config)} + [char]34)`;
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath ${powershellLiteral(server)} -ArgumentList ${argument} -WindowStyle Hidden"`;
}

export function windowsStartLines(layout: Layout, mariadb: PortableMariaDb): string[] {
    const binaries = portableBinaries(mariadb.home);
    if (!binaries) return [];
    const config = portableConfigFile(layout);
    const ping = `"${binaries.admin}" --defaults-file="${config}" --connect-timeout=2 ping >nul 2>&1`;
    return [
        `${ping} || ${hiddenStartLine(binaries.server, config)}`,
        'set /a PRAX_DB_WAIT=0',
        ':wait_mariadb',
        `${ping} && goto mariadb_ready`,
        'set /a PRAX_DB_WAIT+=1',
        'if %PRAX_DB_WAIT% geq 60 goto mariadb_ready',
        'ping -n 2 127.0.0.1 >nul',
        'goto wait_mariadb',
        ':mariadb_ready',
    ];
}

export function writeWindowsDatabaseScript(layout: Layout, mariadb: PortableMariaDb): string | null {
    const lines = windowsStartLines(layout, mariadb);
    if (!lines.length) return null;
    const file = path.join(layout.root, DATABASE_SCRIPT);
    const body = ['@echo off', 'setlocal', ...lines, 'echo MariaDB tourne.', 'timeout /t 3 >nul'];
    fs.writeFileSync(file, body.join('\r\n') + '\r\n');
    log.ok(`Relance de MariaDB seule : ${DATABASE_SCRIPT}`);
    return file;
}
