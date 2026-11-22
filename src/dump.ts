import fs from 'node:fs';
import readline from 'node:readline';
import mysql from 'mysql2/promise';
import type { DatabaseAccess } from './database.ts';
import { explainDatabaseError } from './database.ts';

const INSERT_ROWS = 200;
const TLS_OPTIONS = { rejectUnauthorized: false };

export type DumpResult = { tables: number; rows: number; bytes: number };

type TypeCastField = { type: string; string(): string | null };
type RowStream = AsyncIterable<Record<string, unknown>>;
type CoreConnection = { query(sql: string): { stream(): RowStream } };

function jsonAsText(field: TypeCastField, next: () => unknown): unknown {
    return field.type === 'JSON' ? field.string() : next();
}

function quoteName(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
}

async function connect(access: DatabaseAccess): Promise<mysql.Connection> {
    const { tls, ...options } = access;
    try {
        return await mysql.createConnection({
            ...options,
            connectTimeout: 8000,
            dateStrings: true,
            supportBigNumbers: true,
            bigNumberStrings: true,
            typeCast: jsonAsText as mysql.ConnectionOptions['typeCast'],
            ...(tls ? { ssl: TLS_OPTIONS } : {}),
        });
    } catch (error) {
        throw explainDatabaseError(error, access);
    }
}

export async function dumpDatabase(access: DatabaseAccess, file: string): Promise<DumpResult> {
    const connection = await connect(access);
    const partial = `${file}.part`;
    const handle = fs.openSync(partial, 'w', 0o600);
    let bytes = 0;
    const write = (text: string) => {
        bytes += fs.writeSync(handle, `${text}\n`);
    };
    let tables = 0;
    let rows = 0;
    try {
        write('SET NAMES utf8mb4;');
        write('SET FOREIGN_KEY_CHECKS=0;');
        const [listed] = await connection.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
        const names = (listed as Record<string, unknown>[]).map((row) => String(Object.values(row)[0]));
        const core = (connection as unknown as { connection: CoreConnection }).connection;
        for (const name of names) {
            const table = quoteName(name);
            const [created] = await connection.query(`SHOW CREATE TABLE ${table}`);
            const statement = String((created as Record<string, unknown>[])[0]?.['Create Table'] ?? '');
            write(`DROP TABLE IF EXISTS ${table};`);
            write(`${statement.replace(/\r?\n\s*/g, ' ')};`);
            let batch: string[] = [];
            const flush = () => {
                if (batch.length === 0) return;
                write(`INSERT INTO ${table} VALUES ${batch.join(',')};`);
                batch = [];
            };
            for await (const row of core.query(`SELECT * FROM ${table}`).stream()) {
                batch.push(`(${Object.values(row).map((value) => connection.escape(value)).join(',')})`);
                rows++;
                if (batch.length >= INSERT_ROWS) flush();
            }
            flush();
            tables++;
        }
        write('SET FOREIGN_KEY_CHECKS=1;');
    } catch (error) {
        fs.closeSync(handle);
        fs.rmSync(partial, { force: true });
        throw explainDatabaseError(error, access);
    } finally {
        await connection.end().catch(() => undefined);
    }
    fs.closeSync(handle);
    fs.renameSync(partial, file);
    return { tables, rows, bytes };
}

export async function restoreDatabase(access: DatabaseAccess, file: string): Promise<number> {
    const connection = await connect(access);
    let statements = 0;
    try {
        const lines = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
        for await (const line of lines) {
            if (line.trim() === '') continue;
            await connection.query(line);
            statements++;
        }
    } catch (error) {
        throw explainDatabaseError(error, access);
    } finally {
        await connection.end().catch(() => undefined);
    }
    return statements;
}
