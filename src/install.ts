import fs from 'node:fs';
import path from 'node:path';
import { Answers } from './answers.ts';
import { connectionString, createWithAdmin, testAccess } from './database.ts';
import type { DatabaseAccess, DatabaseSetup } from './database.ts';
import { installFxServer, resolveBuild } from './fxserver.ts';
import type { FxChannel } from './fxserver.ts';
import { layoutOf } from './layout.ts';
import type { Layout } from './layout.ts';
import { writeLaunchScript } from './launch.ts';
import { InstallError, log } from './log.ts';
import { installFromBuild } from './manifest.ts';
import { detectHost, freeDiskBytes, isAsciiPath, isPortFree } from './platform.ts';
import type { Host } from './platform.ts';
import { randomPassword } from './database.ts';
import { renderServerCfg } from './servercfg.ts';
import { InstallState, readPrivateJson, writePrivateJson } from './state.ts';
import { licenseDirectives, parseLicense, readLicenseFile } from './license.ts';
import type { InstallLicense } from './license.ts';
import { prepareTxAdmin } from './txadmin.ts';

export type InstallOptions = {
    dir: string;
    from: string | undefined;
    answersFile: string | undefined;
    interactive: boolean;
    fxChannel: FxChannel;
    withTxAdmin: boolean;
    reconfigure: boolean;
    gamePort: number | null;
    txAdminPort: number;
    licenseFile: string | undefined;
};

type LocalSecrets = {
    rconPassword?: string;
    database?: DatabaseSetup;
};

const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024;

const notEmpty = (value: string) => (value.trim() === '' ? 'ne peut pas être vide' : null);
const isPort = (value: string) => (/^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) < 65536 ? null : 'port invalide');

async function checkSystem(layout: Layout, host: Host): Promise<void> {
    log.step('Vérification du système');
    log.ok(`${host.target === 'windows' ? 'Windows' : 'Linux'} x64${host.container ? `, conteneur ${host.container}` : ''}`);

    if (!isAsciiPath(layout.root)) {
        throw new InstallError(
            `Le dossier d'installation contient des caractères spéciaux : ${layout.root}`,
            'txAdmin refuse les accents et les caractères non latins. Choisis par exemple C:\\prax-server.',
        );
    }

    fs.mkdirSync(layout.root, { recursive: true });
    const free = await freeDiskBytes(layout.root);
    if (free < MIN_FREE_BYTES) {
        throw new InstallError(`Pas assez de place : ${(free / 1024 ** 3).toFixed(1)} Go libres, il en faut au moins 3.`);
    }
    log.ok(`${(free / 1024 ** 3).toFixed(0)} Go libres`);

    if (!host.container) {
        if (!(await isPortFree(host.gamePort, true))) {
            log.warn(`Le port ${host.gamePort} est déjà utilisé : un autre serveur tourne peut-être déjà.`);
        } else {
            log.ok(`Port ${host.gamePort} libre`);
        }
    }
}

async function installBase(layout: Layout, options: InstallOptions, state: InstallState): Promise<void> {
    log.step('Base Prax');
    if (!options.from) {
        throw new InstallError(
            'Le téléchargement par le compte client arrive bientôt.',
            'Pour l\'instant, indique le dossier d\'un build avec --from <dossier build/<version>>.',
        );
    }
    const manifest = await installFromBuild(layout, path.resolve(options.from));
    state.markDone('base', { version: manifest.version, commit: manifest.commit });
}

async function setupDatabase(answers: Answers, host: Host, previous: DatabaseSetup | null): Promise<DatabaseSetup> {
    log.step('Base de données');
    const hostedByProvider = host.container !== null;
    const mode = await answers.ask({
        key: 'dbMode',
        label: "Base de données : « create » pour la créer avec un compte administrateur, « existing » pour une base déjà créée (hébergeur)",
        defaultValue: hostedByProvider ? 'existing' : 'create',
        validate: (value) => (value === 'create' || value === 'existing' ? null : 'réponds create ou existing'),
    });

    const dbHost = await answers.ask({ key: 'dbHost', label: 'Adresse de la base', defaultValue: '127.0.0.1', validate: notEmpty });
    const dbPort = Number(await answers.ask({ key: 'dbPort', label: 'Port de la base', defaultValue: '3306', validate: isPort }));

    if (mode === 'existing') {
        const access: DatabaseAccess = {
            host: dbHost,
            port: dbPort,
            database: await answers.ask({ key: 'dbName', label: 'Nom de la base', validate: notEmpty }),
            user: await answers.ask({ key: 'dbUser', label: 'Utilisateur', validate: notEmpty }),
            password: await answers.ask({ key: 'dbPassword', label: 'Mot de passe', secret: true, optional: true }),
        };
        const version = await testAccess(access);
        log.ok(`Connexion réussie (${version})`);
        return { server: access, readOnly: null };
    }

    const adminUser = await answers.ask({ key: 'dbAdminUser', label: 'Compte administrateur de MariaDB', defaultValue: 'root', validate: notEmpty });
    const adminPassword = await answers.ask({ key: 'dbAdminPassword', label: 'Mot de passe administrateur', secret: true, optional: true });
    const database = await answers.ask({ key: 'dbName', label: 'Nom de la base à créer', defaultValue: 'prax', validate: notEmpty });
    const setup = await createWithAdmin({ host: dbHost, port: dbPort, user: adminUser, password: adminPassword }, database, previous);
    const version = await testAccess(setup.server);
    log.ok(`Base « ${database} » prête (${version}), utilisateur du serveur et utilisateur en lecture seule créés`);
    return setup;
}

type CfgContext = {
    database: DatabaseSetup | null;
    overrides: string[];
    discordProvided: boolean;
};

async function obtainLicense(options: InstallOptions, answers: Answers): Promise<InstallLicense | null> {
    log.step('Licence Prax');
    if (options.licenseFile) {
        const license = readLicenseFile(path.resolve(options.licenseFile));
        log.ok(`Licence ${license.plan === 'premium' ? 'premium' : 'standard'} : ${license.label}`);
        if (license.premium?.panelUrl) log.ok(`Panel hébergé : ${license.premium.panelUrl}`);
        return license;
    }
    const key = await answers.ask({
        key: 'licenseKey',
        label: 'Clé de licence Prax (PRAX-XXXX-…, dans ton espace client)',
        optional: true,
    });
    if (!key) {
        log.warn('Aucune licence : server.cfg sera fait sans elle, ajoute-la avant de lancer le serveur.');
        return null;
    }
    const secret = await answers.ask({ key: 'licenseSecret', label: 'Secret de la licence', secret: true });
    const license = parseLicense({ format: 1, license: { key, secret, plan: 'standard' } });
    log.ok('Licence standard renseignée');
    return license;
}

async function usesHostedDatabase(answers: Answers, host: Host, license: InstallLicense | null): Promise<boolean> {
    if (!license?.premium?.hostedDatabase) return false;
    log.step('Base de données');
    log.info('Ta licence premium comprend une base de données hébergée par Prax.');
    log.info("Elle n'accepte que l'adresse IP du serveur de production déclarée dans ton espace client.");
    const production = await answers.confirm('Ce serveur est-il ton serveur de production', host.container !== null);
    if (production) {
        log.ok('Base hébergée par Prax utilisée');
        log.warn("Vérifie dans ton espace client que l'IP déclarée est bien celle de ce serveur.");
        return true;
    }
    log.info('Serveur de test : il aura sa propre base, la base hébergée reste réservée à la production.');
    return false;
}

async function writeServerCfg(layout: Layout, answers: Answers, host: Host, context: CfgContext, secrets: LocalSecrets): Promise<void> {
    log.step('Configuration du serveur (server.cfg)');
    if (!fs.existsSync(layout.serverCfgTemplate)) {
        throw new InstallError('Le build ne contient pas server.cfg.example.', 'Refais le build avec release.bat.');
    }

    const hostname = await answers.ask({ key: 'serverName', label: 'Nom du serveur', defaultValue: 'Mon serveur Prax', validate: notEmpty });
    const cfxLicenseKey = await answers.ask({
        key: 'cfxLicenseKey',
        label: 'Clé de licence Cfx (portal.cfx.re, commence par cfxk_)',
        secret: true,
        validate: (value) => (value.startsWith('cfxk_') ? null : 'la clé commence par cfxk_'),
    });
    const owners = await answers.ask({
        key: 'owners',
        label: 'Propriétaire du serveur (identifiant, par exemple license:abc123…)',
        validate: (value) => (/^(license|license2|fivem|discord|steam):\S+$/.test(value) ? null : 'format attendu : license:… ou discord:…'),
    });
    const maxClients = Number(await answers.ask({
        key: 'maxClients',
        label: 'Nombre de places',
        defaultValue: '48',
        validate: (value) => (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 2048 ? null : 'entre 1 et 2048'),
    }));
    const steamWebApiKey = await answers.ask({ key: 'steamWebApiKey', label: 'Clé Steam Web API', secret: true, optional: true });
    const discordClientId = context.discordProvided ? '' : await answers.ask({ key: 'discordClientId', label: 'Discord : identifiant de l\'application', optional: true });
    const discordClientSecret = discordClientId
        ? await answers.ask({ key: 'discordClientSecret', label: 'Discord : secret de l\'application', secret: true, optional: true })
        : '';

    secrets.rconPassword ??= randomPassword();
    const template = fs.readFileSync(layout.serverCfgTemplate, 'utf8');
    const rendered = renderServerCfg(template, {
        connectionString: context.database ? connectionString(context.database.server) : '',
        gamePort: host.gamePort,
        hostname,
        projectName: hostname,
        projectDescription: hostname,
        maxClients,
        cfxLicenseKey,
        steamWebApiKey,
        owners,
        discordClientId,
        discordClientSecret,
        botKey: '',
        rconPassword: secrets.rconPassword,
        oneSync: 'on',
    }, layout.data, context.overrides);
    fs.writeFileSync(layout.serverCfg, rendered, { mode: 0o600 });
    log.ok('server.cfg écrit (il contient des secrets : ne le partage jamais)');
}

async function setupTxAdmin(layout: Layout, answers: Answers): Promise<void> {
    log.step('txAdmin');
    const adminName = await answers.ask({
        key: 'txAdminUser',
        label: 'Nom du compte admin txAdmin',
        defaultValue: 'admin',
        validate: (value) => (/^[A-Za-z0-9._-]{3,20}$/.test(value) ? null : '3 à 20 lettres, chiffres, point, tiret'),
    });
    const adminPassword = await answers.ask({
        key: 'txAdminPassword',
        label: 'Mot de passe txAdmin (12 caractères au moins)',
        secret: true,
        validate: (value) => (value.length >= 12 ? null : '12 caractères au moins'),
    });
    prepareTxAdmin(layout, { adminName, adminPassword, oneSync: 'on' });
}

export async function runInstall(options: InstallOptions): Promise<void> {
    const layout = layoutOf(options.dir);
    const host = detectHost(options.gamePort);
    const answers = new Answers(options.answersFile, options.interactive);
    const state = new InstallState(layout.state);
    const secrets = readPrivateJson<LocalSecrets>(layout.localSecrets) ?? {};

    log.title(`Installation de la base Prax dans ${layout.root}`);
    await checkSystem(layout, host);
    await installBase(layout, options, state);

    log.step('FXServer');
    const fx = await resolveBuild(host.target, options.fxChannel);
    await installFxServer(layout, host.target, fx);
    state.markDone('fxserver', { build: fx.build });

    const cfgExists = fs.existsSync(layout.serverCfg);
    if (cfgExists && !options.reconfigure) {
        log.step('Configuration du serveur (server.cfg)');
        log.skip('server.cfg existe déjà : gardé tel quel (--reconfigure pour le refaire)');
    } else {
        const license = await obtainLicense(options, answers);
        const hosted = await usesHostedDatabase(answers, host, license);
        let database: DatabaseSetup | null = null;
        if (!hosted) {
            database = await setupDatabase(answers, host, secrets.database ?? null);
            secrets.database = database;
            writePrivateJson(layout.localSecrets, secrets);
        }
        const overrides = license ? licenseDirectives(license, { useHostedDatabase: hosted }) : [];
        const discordProvided = overrides.some((line) => line.startsWith('set px:discord_client_id '));
        await writeServerCfg(layout, answers, host, { database, overrides, discordProvided }, secrets);
        writePrivateJson(layout.localSecrets, secrets);
        state.markDone('servercfg');
    }

    if (options.withTxAdmin) {
        await setupTxAdmin(layout, answers);
        state.markDone('txadmin');
    }

    if (host.container !== 'pterodactyl') {
        log.step('Démarrage');
        const script = writeLaunchScript(layout, {
            target: host.target,
            withTxAdmin: options.withTxAdmin,
            txAdminPort: options.txAdminPort,
            forcedGamePort: host.container || options.gamePort ? host.gamePort : null,
        });
        log.info(`Lance ${script}`);
        if (options.withTxAdmin) log.info(`Puis ouvre http://localhost:${options.txAdminPort} et connecte-toi avec le compte txAdmin.`);
        log.info(`En jeu : F8 puis « connect localhost:${host.gamePort} ».`);
    }

    log.step('Terminé');
    log.ok('La base Prax est installée.');
}
