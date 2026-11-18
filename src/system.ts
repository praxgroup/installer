import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Layout } from './layout.ts';
import { log } from './log.ts';
import type { Target } from './platform.ts';

const ONLINE_TIMEOUT_MS = 300_000;
const ONLINE_POLL_MS = 3_000;
const REQUIRED_RESOURCES = ['pcore', 'pguard'];

export type FirewallPort = { port: number; protocol: 'TCP' | 'UDP'; label: string };
export type Autostart = { kind: 'systemd' | 'schtasks' | 'startup-folder'; name: string };

function succeeds(command: string, args: string[]): boolean {
    try {
        execFileSync(command, args, { stdio: 'ignore', windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

function output(command: string, args: string[]): string {
    try {
        return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
        return '';
    }
}

export function isElevated(target: Target): boolean {
    if (target === 'windows') return succeeds('net', ['session']);
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

export function serviceSlug(layout: Layout): string {
    const slug = path.basename(layout.root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return slug || 'serveur';
}

function windowsRuleName(entry: FirewallPort): string {
    return `Prax-${entry.label}-${entry.port}-${entry.protocol}`;
}

function windowsFirewallArgs(entry: FirewallPort): string[] {
    return ['advfirewall', 'firewall', 'add', 'rule', `name=${windowsRuleName(entry)}`, 'dir=in', 'action=allow', `protocol=${entry.protocol}`, `localport=${entry.port}`];
}

function linuxFirewall(): 'ufw' | 'firewalld' | null {
    if (/Status:\s*active/i.test(output('ufw', ['status']))) return 'ufw';
    if (output('firewall-cmd', ['--state']).trim() === 'running') return 'firewalld';
    return null;
}

export function openFirewall(target: Target, ports: FirewallPort[]): void {
    const elevated = isElevated(target);
    if (target === 'windows') {
        const missing = ports.filter((entry) => !succeeds('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${windowsRuleName(entry)}`]));
        if (missing.length === 0) {
            log.skip('Ports déjà ouverts dans le pare-feu Windows');
            return;
        }
        if (!elevated) {
            log.warn("Le pare-feu demande les droits administrateur. Lance ces commandes dans un PowerShell ouvert en administrateur :");
            for (const entry of missing) log.info(`    netsh ${windowsFirewallArgs(entry).join(' ')}`);
            return;
        }
        for (const entry of missing) execFileSync('netsh', windowsFirewallArgs(entry), { stdio: 'ignore', windowsHide: true });
        log.ok(`Pare-feu Windows : ${missing.map((entry) => `${entry.port}/${entry.protocol}`).join(', ')} ouverts`);
        return;
    }

    const firewall = linuxFirewall();
    const commands = firewall === 'ufw'
        ? ports.map((entry) => ['ufw', 'allow', `${entry.port}/${entry.protocol.toLowerCase()}`])
        : firewall === 'firewalld'
            ? [...ports.map((entry) => ['firewall-cmd', '--permanent', `--add-port=${entry.port}/${entry.protocol.toLowerCase()}`]), ['firewall-cmd', '--reload']]
            : [];
    if (!firewall) {
        log.skip('Aucun pare-feu actif détecté sur la machine (ni ufw, ni firewalld)');
    } else if (!elevated) {
        log.warn(`Le pare-feu ${firewall} demande les droits root. Lance :`);
        for (const command of commands) log.info(`    sudo ${command.join(' ')}`);
    } else {
        for (const [command, ...args] of commands) execFileSync(command as string, args, { stdio: 'ignore' });
        log.ok(`Pare-feu ${firewall} : ${ports.map((entry) => `${entry.port}/${entry.protocol}`).join(', ')} ouverts`);
    }
    log.info("Chez un hébergeur (Oracle, AWS, OVH…), ouvre aussi ces ports dans son panel : c'est un pare-feu à part.");
}

function systemdUnit(layout: Layout, script: string, user: string, name: string): string {
    return [
        '[Unit]',
        `Description=Serveur FiveM Prax (${name})`,
        'After=network-online.target mariadb.service',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        `User=${user}`,
        `WorkingDirectory=${layout.root}`,
        `ExecStart=${script}`,
        'Restart=on-failure',
        'RestartSec=10',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
    ].join('\n');
}

function startupFolder(): string {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function installAutostart(layout: Layout, target: Target, script: string): Autostart | null {
    const slug = serviceSlug(layout);
    const elevated = isElevated(target);
    if (target === 'windows') {
        if (elevated) {
            const name = `Prax\\${slug}`;
            execFileSync('schtasks', ['/Create', '/TN', name, '/TR', `"${script}"`, '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'], { stdio: 'ignore', windowsHide: true });
            log.ok(`Tâche planifiée « ${name} » : le serveur démarre avec Windows, même sans session ouverte`);
            return { kind: 'schtasks', name };
        }
        const file = path.join(startupFolder(), `Prax ${slug}.cmd`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `@echo off\r\nstart "Prax" /min "${script}"\r\n`);
        log.ok('Le serveur démarrera à l\'ouverture de ta session Windows');
        log.info('Pour qu\'il démarre avec la machine, même sans session ouverte, relance prax install en administrateur.');
        return { kind: 'startup-folder', name: file };
    }

    if (!fs.existsSync('/run/systemd/system')) {
        log.warn("systemd est absent : ajoute toi-même le lancement de start.sh au démarrage de la machine.");
        return null;
    }
    const name = `prax-${slug}`;
    const unitFile = `/etc/systemd/system/${name}.service`;
    if (!elevated) {
        log.warn('Le service systemd demande les droits root. Relance prax install avec sudo, ou crée-le toi-même :');
        log.info(`    ${unitFile} avec ExecStart=${script}`);
        return null;
    }
    const user = process.env.SUDO_USER && process.env.SUDO_USER !== 'root' ? process.env.SUDO_USER : 'root';
    if (user !== 'root') execFileSync('chown', ['-R', `${user}:`, layout.root], { stdio: 'ignore' });
    fs.writeFileSync(unitFile, systemdUnit(layout, script, user, slug));
    execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['enable', name], { stdio: 'ignore' });
    log.ok(`Service systemd « ${name} » activé, lancé en tant que ${user}`);
    if (user === 'root') log.warn('Le serveur tournera en root : mieux vaut lancer prax install avec sudo depuis un compte normal.');
    return { kind: 'systemd', name };
}

export function startServer(layout: Layout, target: Target, script: string, autostart: Autostart | null): void {
    if (autostart?.kind === 'systemd') {
        execFileSync('systemctl', ['restart', autostart.name], { stdio: 'ignore' });
        return;
    }
    if (autostart?.kind === 'schtasks') {
        execFileSync('schtasks', ['/Run', '/TN', autostart.name], { stdio: 'ignore', windowsHide: true });
        return;
    }
    if (target === 'windows') {
        spawn('cmd.exe', ['/d', '/s', '/c', `start "Prax" "${script}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
        return;
    }
    fs.mkdirSync(path.dirname(layout.serverLog), { recursive: true });
    const logFile = fs.openSync(layout.serverLog, 'a');
    spawn('sh', [script], { detached: true, stdio: ['ignore', logFile, logFile], cwd: layout.root }).unref();
    fs.closeSync(logFile);
}

export type ServerInfo = { resources: string[]; server: string };

export async function probeServer(port: number, timeoutMs = 2_000): Promise<ServerInfo | null> {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/info.json`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) return null;
        const info = (await response.json()) as { resources?: unknown; server?: unknown };
        return {
            resources: Array.isArray(info.resources) ? info.resources.map(String) : [],
            server: typeof info.server === 'string' ? info.server : '',
        };
    } catch {
        return null;
    }
}

export function missingResources(info: ServerInfo): string[] {
    return REQUIRED_RESOURCES.filter((resource) => !info.resources.includes(resource));
}

export async function waitOnline(port: number, onTick: (elapsedSeconds: number) => void): Promise<ServerInfo | null> {
    const started = Date.now();
    while (Date.now() - started < ONLINE_TIMEOUT_MS) {
        const info = await probeServer(port);
        if (info && missingResources(info).length === 0) return info;
        onTick(Math.round((Date.now() - started) / 1000));
        await new Promise((resolve) => setTimeout(resolve, ONLINE_POLL_MS));
    }
    return probeServer(port);
}
