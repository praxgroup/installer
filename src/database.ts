import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { InstallError } from './log.ts';

export type DatabaseAccess = {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    tls?: boolean;
};

export type DatabaseSetup = {
    server: DatabaseAccess;
    readOnly: DatabaseAccess | null;
};

const POOL_OPTIONS = 'maxIdle=5;idleTimeout=120000;keepAliveInitialDelay=30000';
const POOL_QUERY = 'charset=utf8mb4&maxIdle=5&idleTimeout=120000&keepAliveInitialDelay=30000';
const TLS_OPTIONS = { rejectUnauthorized: false };
const MAX_USER_LENGTH = 32;

function userNamesFor(database: string): { server: string; readOnly: string } {
    const base = database.slice(0, MAX_USER_LENGTH - '_readonly'.length);
    return { server: `${base}_server`, readOnly: `${base}_readonly` };
}

export function randomPassword(): string {
    return crypto.randomBytes(24).toString('base64url');
}

function assertConnectionValue(label: string, value: string): void {
    if (/[;"]/.test(value)) throw new InstallError(`${label} ne doit contenir ni « ; » ni guillemet.`, 'Choisis-en un autre : oxmysql coupe la chaîne de connexion sur ces caractères.');
}

export function connectionString(access: DatabaseAccess): string {
    for (const [label, value] of [['Le nom de la base', access.database], ["L'utilisateur", access.user], ['Le mot de passe', access.password]] as const) {
        assertConnectionValue(label, value);
    }
    if (access.tls) {
        const credentials = `${encodeURIComponent(access.user)}:${encodeURIComponent(access.password)}`;
        return `mysql://${credentials}@${access.host}:${access.port}/${access.database}?${POOL_QUERY}&ssl={\\"rejectUnauthorized\\":false}`;
    }
    const server = access.port === 3306 ? access.host : `${access.host};port=${access.port}`;
    return `server=${server};database=${access.database};userid=${access.user};password=${access.password};${POOL_OPTIONS}`;
}

function explain(error: unknown, access: { host: string; port: number }): InstallError {
    const code = (error as { code?: string }).code ?? '';
    if (code === 'ECONNREFUSED') return new InstallError(`Aucune base de données ne répond sur ${access.host}:${access.port}.`, 'Vérifie que MariaDB est lancé et que le port est le bon.');
    if (code === 'ER_ACCESS_DENIED_ERROR') return new InstallError('La base de données refuse cet utilisateur ou ce mot de passe.');
    if (code === 'ENOTFOUND') return new InstallError(`Adresse de base de données inconnue : ${access.host}.`);
    if (code === 'ER_BAD_DB_ERROR') return new InstallError('Cette base de données n\'existe pas.', "Crée-la dans le panel de ton hébergeur, ou laisse l'installeur la créer avec un compte administrateur.");
    return new InstallError(`Connexion à la base impossible : ${(error as Error).message}`);
}

function isTlsUnsupported(error: unknown): boolean {
    return /does not support secure|SSL is required|HANDSHAKE_NO_SSL_SUPPORT/i.test(`${(error as { code?: string }).code ?? ''} ${(error as Error).message ?? ''}`);
}

async function openConnection(access: Omit<DatabaseAccess, 'database'> & { database?: string }): Promise<{ connection: mysql.Connection; tls: boolean }> {
    const { tls, ...options } = access;
    const base = { ...options, connectTimeout: 8000 };
    if (tls === false) return { connection: await mysql.createConnection(base), tls: false };
    try {
        return { connection: await mysql.createConnection({ ...base, ssl: TLS_OPTIONS }), tls: true };
    } catch (error) {
        if (tls === true || !isTlsUnsupported(error)) throw error;
        return { connection: await mysql.createConnection(base), tls: false };
    }
}

export async function testAccess(access: DatabaseAccess): Promise<{ version: string; tls: boolean }> {
    let connection: mysql.Connection | undefined;
    try {
        const opened = await openConnection(access);
        connection = opened.connection;
        const [rows] = await connection.query('SELECT VERSION() AS version');
        return { version: String((rows as Array<{ version: string }>)[0]?.version ?? 'inconnue'), tls: opened.tls };
    } catch (error) {
        throw explain(error, access);
    } finally {
        await connection?.end().catch(() => undefined);
    }
}

function quoteIdentifier(value: string): string {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(value)) throw new InstallError(`Nom refusé : ${value} (lettres, chiffres et _ seulement).`);
    return `\`${value}\``;
}

async function userExists(connection: mysql.Connection, user: string): Promise<boolean> {
    const [rows] = await connection.query('SELECT 1 FROM mysql.user WHERE User = ? LIMIT 1', [user]);
    return (rows as unknown[]).length > 0;
}

export async function createWithAdmin(admin: Omit<DatabaseAccess, 'database'>, database: string, previous: DatabaseSetup | null): Promise<DatabaseSetup> {
    let connection: mysql.Connection | undefined;
    try {
        const opened = await openConnection(admin);
        connection = opened.connection;
        const schema = quoteIdentifier(database);
        const users = userNamesFor(database);
        const base = { host: admin.host, port: admin.port, database, tls: opened.tls };

        const reusable = previous && previous.server.database === database && previous.server.user === users.server && previous.readOnly?.user === users.readOnly;
        if (reusable && previous.readOnly) {
            await testAccess(previous.server);
            return previous;
        }

        for (const user of [users.server, users.readOnly]) {
            if (await userExists(connection, user)) {
                throw new InstallError(
                    `L'utilisateur MariaDB « ${user} » existe déjà : l'installeur ne touche jamais à un utilisateur qu'il n'a pas créé.`,
                    'Choisis un autre nom de base, ou réponds « existing » pour utiliser une base et un utilisateur déjà prêts.',
                );
            }
        }

        const serverPassword = randomPassword();
        const readOnlyPassword = randomPassword();
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await connection.query('CREATE USER ?@? IDENTIFIED BY ?', [users.server, '%', serverPassword]);
        await connection.query('CREATE USER ?@? IDENTIFIED BY ?', [users.readOnly, '%', readOnlyPassword]);
        await connection.query(`GRANT ALL PRIVILEGES ON ${schema}.* TO ?@?`, [users.server, '%']);
        await connection.query(`GRANT SELECT ON ${schema}.* TO ?@?`, [users.readOnly, '%']);

        return {
            server: { ...base, user: users.server, password: serverPassword },
            readOnly: { ...base, user: users.readOnly, password: readOnlyPassword },
        };
    } catch (error) {
        if (error instanceof InstallError) throw error;
        throw explain(error, admin);
    } finally {
        await connection?.end().catch(() => undefined);
    }
}
