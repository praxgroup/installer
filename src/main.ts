import { parseArgs } from 'node:util';
import { runDoctor } from './doctor.ts';
import type { FxChannel } from './fxserver.ts';
import { runInstall } from './install.ts';
import { InstallError, log } from './log.ts';
import { DEFAULT_TXADMIN_PORT } from './platform.ts';

const VERSION = '0.1.0';

const USAGE = `prax ${VERSION} : installe et configure la base Prax

Utilisation :
  prax install [options]     installe la base, FXServer, la base de données, server.cfg et txAdmin
  prax doctor [--dir <dossier>]   cherche ce qui empêche le serveur de démarrer
  prax version

Options de prax install :
  --dir <dossier>        dossier d'installation (par défaut : ./prax-server)
  --from <dossier>       build local de la base (dossier build/<version> avec manifest.json)
  --license <fichier>    fichier d'installation de l'espace client (licence et services premium)
  --answers <fichier>    réponses en JSON, pour une installation sans questions
  --yes                  ne pose aucune question (réponses par --answers ou variables PRAX_*)
  --fxserver <canal>     recommended (par défaut) ou latest
  --no-txadmin           démarrer FXServer directement, sans txAdmin
  --reconfigure          refaire server.cfg même s'il existe
  --game-port <port>     port du jeu (par défaut 30120, ou celui de l'hébergeur)
  --txadmin-port <port>  port de txAdmin (par défaut 40120)`;

function parsePort(value: string, option: string): number {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InstallError(`Port invalide pour ${option} : ${value}`);
    return port;
}

async function main(): Promise<number> {
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

    if (command === 'install') {
        if (values.fxserver !== 'recommended' && values.fxserver !== 'latest') {
            throw new InstallError(`Canal FXServer inconnu : ${values.fxserver}`, 'Utilise recommended ou latest.');
        }
        const gamePort = values['game-port'] === undefined ? null : parsePort(values['game-port'], '--game-port');
        const txAdminPort = parsePort(values['txadmin-port'], '--txadmin-port');
        await runInstall({
            gamePort,
            txAdminPort,
            licenseFile: values.license,
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
