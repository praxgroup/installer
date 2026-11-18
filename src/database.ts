import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { InstallError } from './log.ts';

export type DatabaseAccess = {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
};

export type DatabaseSetup = {
    server: DatabaseAccess;
    readOnly: DatabaseAccess | null;
};

const POOL_OPTIONS = 'maxIdle=5;idleTimeout=120000;keepAliveInitialDelay=30000';
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

export async function testAccess(access: DatabaseAccess): Promise<string> {
    let connection: mysql.Connection | undefined;
    try {
        connection = await mysql.createConnection({ ...access, connectTimeout: 8000 });
        const [rows] = await connection.query('SELECT VERSION() AS version');
        return String((rows as Array<{ version: string }>)[0]?.version ?? 'inconnue');
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
        connection = await mysql.createConnection({ ...admin, connectTimeout: 8000 });
        const schema = quoteIdentifier(database);
        const users = userNamesFor(database);
        const base = { host: admin.host, port: admin.port, database };

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
