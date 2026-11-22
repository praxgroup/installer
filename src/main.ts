import { parseArgs } from 'node:util';
import { CONFIG_USAGE, runConfig } from './configcli.ts';
import { runDoctor } from './doctor.ts';
import type { FxChannel } from './fxserver.ts';
import { runInstall } from './install.ts';
import { BASE_CHANNELS, isBaseChannel, type BaseChannel } from './account.ts';
import { InstallError, log } from './log.ts';
import { DEFAULT_TXADMIN_PORT } from './platform.ts';
import { IA_USAGE, runIa } from './ia.ts';
import { runMcp } from './mcp.ts';
import { runRollback, runUpdate } from './update.ts';

const VERSION = '0.3.0';

const MCP_USAGE = `prax mcp [--dir <dossier>] : serveur MCP local (stdio) pour Claude, Cursor ou une autre IA.
Il n'affiche rien lui-même : c'est l'IA qui le lance. Pour le brancher : prax ia claude-desktop.`;

const USAGE = `prax ${VERSION} : installe et configure la base Prax

Utilisation :
  prax install [options]     installe la base, FXServer, la base de données, server.cfg et txAdmin
  prax update [options]      met la base à jour (fichiers changés seulement), avec sauvegarde et retour arrière
  prax doctor [--dir <dossier>]   cherche ce qui empêche le serveur de démarrer
  prax config <get|set|unset|check>   lit et modifie les réglages de la base (prax config --help)
  prax ia <claude-desktop|claude-code|config>   branche une IA sur ce serveur (prax ia --help)
  prax mcp [--dir <dossier>]   serveur MCP local, lancé par l'IA
  prax version

Options de prax install :
  --dir <dossier>        dossier d'installation (par défaut : ./prax-server)
  --from <dossier>       build local de la base (dossier build/<version> avec manifest.json), au lieu de la télécharger
  --token <jeton>        jeton d'installation de l'espace client (sinon : code à entrer sur le site)
  --version <X.Y.Z>      version de la base à installer (par défaut : la dernière du canal)
  --channel <canal>      release (par défaut), early (premium, stable et en avance), beta (pas stable) ou dev (équipe Prax) ; retenu pour les mises à jour
  --site <adresse>       site Prax (par défaut : https://prax-studio.fr)
  --license <fichier>    fichier d'installation de l'espace client (licence et services premium)
  --answers <fichier>    réponses en JSON, pour une installation sans questions
  --yes                  ne pose aucune question (réponses par --answers ou variables PRAX_*)
  --fxserver <canal>     recommended (par défaut) ou latest
  --no-txadmin           démarrer FXServer directement, sans txAdmin
  --reconfigure          refaire server.cfg même s'il existe
  --game-port <port>     port du jeu (par défaut 30120, ou celui de l'hébergeur)
  --txadmin-port <port>  port de txAdmin (par défaut 40120)
  --mariadb-from <dossier>  MariaDB pour Windows déjà extrait (dossier avec bin\), au lieu de le télécharger

Options de prax update :
  --dir <dossier>        dossier du serveur (par défaut : ./prax-server)
  --version <X.Y.Z>      version voulue (par défaut : la dernière du canal retenu)
  --channel <canal>      change de canal (release, early, beta, dev) et le retient
  --token <jeton>        jeton de l'espace client (sinon : la licence de server.cfg, puis un code)
  --no-db-backup         ne pas exporter la base avant la mise à jour
  --no-restart           ne pas redémarrer le serveur
  --force                réinstaller la même version
  --rollback             revenir à la version d'avant la dernière mise à jour (fichiers)
  --database             avec --rollback : remettre aussi la base exportée (serveur arrêté)`;

function parsePort(value: string, option: string): number {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InstallError(`Port invalide pour ${option} : ${value}`);
    return port;
}

type DirArgs = { args: string[]; dir: string; resources: string | undefined; help: boolean };

function parseDirArgs(argv: string[]): DirArgs {
    const parsed: DirArgs = { args: [], dir: 'prax-server', resources: undefined, help: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index] ?? '';
        if (arg === '--dir' || arg === '--resources') {
            const value = argv[++index];
            if (!value) throw new InstallError(`${arg} demande un dossier`);
            if (arg === '--dir') parsed.dir = value;
            else parsed.resources = value;
        } else if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else {
            parsed.args.push(arg);
        }
    }
    return parsed;
}

function runConfigCommand(argv: string[]): number {
    const parsed = parseDirArgs(argv);
    if (parsed.help) {
        console.log(CONFIG_USAGE);
        return 0;
    }
    return runConfig(parsed.args, parsed.dir, parsed.resources);
}

async function runMcpCommand(argv: string[]): Promise<number> {
    const parsed = parseDirArgs(argv);
    if (parsed.help) {
        console.error(MCP_USAGE);
        return 0;
    }
    return runMcp(parsed.dir, parsed.resources, VERSION);
}

function runIaCommand(argv: string[]): number {
    const parsed = parseDirArgs(argv);
    if (parsed.help) {
        console.log(IA_USAGE);
        return 0;
    }
    return runIa(parsed.args, parsed.dir);
}

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    if (argv[0] === 'config') return runConfigCommand(argv.slice(1));
    if (argv[0] === 'mcp') return runMcpCommand(argv.slice(1));
    if (argv[0] === 'ia') return runIaCommand(argv.slice(1));

    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            dir: { type: 'string', default: 'prax-server' },
            from: { type: 'string' },
            answers: { type: 'string' },
            yes: { type: 'boolean', default: false },
            fxserver: { type: 'string', default: 'recommended' },
            'no-txadmin': { type: 'boolean', default: false },
            reconfigure: { type: 'boolean', default: false },
            'game-port': { type: 'string' },
            license: { type: 'string' },
            'mariadb-from': { type: 'string' },
            token: { type: 'string' },
            version: { type: 'string' },
            channel: { type: 'string' },
            site: { type: 'string' },
            rollback: { type: 'boolean', default: false },
            database: { type: 'boolean', default: false },
            'no-restart': { type: 'boolean', default: false },
            'no-db-backup': { type: 'boolean', default: false },
            force: { type: 'boolean', default: false },
            'txadmin-port': { type: 'string', default: String(DEFAULT_TXADMIN_PORT) },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });

    const command = positionals[0];
    if (!command || values.help) {
        console.log(USAGE);
        return command ? 0 : 1;
    }

    if (command === 'version') {
        console.log(VERSION);
        return 0;
    }

    if (command === 'doctor') return runDoctor(values.dir);

    if (command === 'update') {
        if (values.channel !== undefined && !isBaseChannel(values.channel)) {
            throw new InstallError(`Canal inconnu : ${values.channel}`, `Utilise ${BASE_CHANNELS.join(', ')}.`);
        }
        if (values.rollback) {
            await runRollback({ dir: values.dir, database: values.database, restart: !values['no-restart'] });
            return 0;
        }
        await runUpdate({
            dir: values.dir,
            version: values.version,
            channel: values.channel as BaseChannel | undefined,
            site: values.site,
            installToken: values.token,
            restart: !values['no-restart'],
            databaseBackup: !values['no-db-backup'],
            force: values.force,
        });
        return 0;
    }

    if (command === 'install') {
        if (values.fxserver !== 'recommended' && values.fxserver !== 'latest') {
            throw new InstallError(`Canal FXServer inconnu : ${values.fxserver}`, 'Utilise recommended ou latest.');
        }
        if (values.channel !== undefined && !isBaseChannel(values.channel)) {
            throw new InstallError(`Canal inconnu : ${values.channel}`, `Utilise ${BASE_CHANNELS.join(', ')}.`);
        }
        const gamePort = values['game-port'] === undefined ? null : parsePort(values['game-port'], '--game-port');
        const txAdminPort = parsePort(values['txadmin-port'], '--txadmin-port');
        await runInstall({
            gamePort,
            txAdminPort,
            licenseFile: values.license,
            mariadbFrom: values['mariadb-from'],
            installToken: values.token,
            version: values.version,
            channel: values.channel as BaseChannel | undefined,
            site: values.site,
            dir: values.dir,
            from: values.from,
            answersFile: values.answers,
            interactive: !values.yes,
            fxChannel: values.fxserver as FxChannel,
            withTxAdmin: !values['no-txadmin'],
            reconfigure: values.reconfigure,
        });
        return 0;
    }

    console.log(USAGE);
    return 1;
}

main().then(
    (code) => process.exit(code),
    (error: unknown) => {
        if (error instanceof InstallError) {
            log.fail(error.message);
            if (error.hint) log.info(`→ ${error.hint}`);
        } else {
            log.fail(`Erreur inattendue : ${(error as Error).stack ?? String(error)}`);
        }
        process.exit(1);
    },
);
