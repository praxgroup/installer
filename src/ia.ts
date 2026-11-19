import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { layoutOf } from './layout.ts';
import { InstallError, log } from './log.ts';

export const IA_USAGE = `Brancher une IA sur ce serveur Prax :
  prax ia claude-desktop   ajoute Prax aux connecteurs de Claude Desktop
  prax ia claude-code      ajoute Prax à Claude Code (pour tous les dossiers)
  prax ia config           affiche la configuration MCP à coller dans Cursor ou un autre outil
  Option : --dir <dossier> (dossier du serveur, par défaut ./prax-server)`;

const SERVER_NAME = 'prax';

type Launch = { command: string; args: string[] };

function launchFor(serverDir: string): Launch {
    const executable = process.execPath;
    const runsFromNode = /^node(\.exe)?$/i.test(path.basename(executable));
    const script = process.argv[1];
    if (runsFromNode && script) return { command: executable, args: [path.resolve(script), 'mcp', '--dir', serverDir] };
    return { command: executable, args: ['mcp', '--dir', serverDir] };
}

function claudeDesktopConfig(): string {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Claude', 'claude_desktop_config.json');
    }
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Claude', 'claude_desktop_config.json');
}

function serverDirOf(dir: string): string {
    const layout = layoutOf(dir);
    if (!fs.existsSync(path.join(layout.resources, 'pcore', 'fxmanifest.lua'))) {
        throw new InstallError(`Aucune base Prax dans ${layout.root}`, 'Lance la commande dans le dossier du serveur, ou indique-le avec --dir.');
    }
    return layout.root;
}

function addToClaudeDesktop(launch: Launch): void {
    const file = claudeDesktopConfig();
    let config: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
        try {
            config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        } catch {
            throw new InstallError(`Le fichier de configuration de Claude Desktop est illisible : ${file}`, 'Corrige-le ou supprime-le, puis relance la commande.');
        }
        fs.copyFileSync(file, `${file}.bak`);
    }
    const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>;
    const replaced = SERVER_NAME in servers;
    servers[SERVER_NAME] = { command: launch.command, args: launch.args };
    config.mcpServers = servers;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    log.ok(`${replaced ? 'Connecteur Prax mis à jour' : 'Connecteur Prax ajouté'} dans Claude Desktop`);
    log.info(file);
    log.info('Quitte complètement Claude Desktop (icône de la barre des tâches), puis rouvre-le : « prax » apparaît dans les connecteurs.');
}

function addToClaudeCode(launch: Launch): void {
    const args = ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', launch.command, ...launch.args];
    const result = spawnSync('claude', args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status === 0) {
        log.ok('Prax ajouté à Claude Code');
        log.info('Lance claude puis demande par exemple : « vérifie que mon serveur Prax est bien installé ».');
        return;
    }
    log.warn('Claude Code n\'a pas pu être lancé. Copie cette commande dans un terminal où claude est installé :');
    log.info(`claude ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`);
}

export function runIa(args: string[], dir: string): number {
    const [client] = args;
    if (!client || !['claude-desktop', 'claude-code', 'config'].includes(client)) {
        console.log(IA_USAGE);
        return client ? 1 : 0;
    }
    const launch = launchFor(serverDirOf(dir));
    if (client === 'claude-desktop') addToClaudeDesktop(launch);
    else if (client === 'claude-code') addToClaudeCode(launch);
    else console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: launch.command, args: launch.args } } }, null, 2));
    log.info('La documentation est aussi accessible à l\'IA par ce connecteur (outils docs_search et docs_guide).');
    return 0;
}
