import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import type { Layout } from './layout.ts';
import { log } from './log.ts';

const TXADMIN_CONFIG_VERSION = 2;
const TXADMIN_ADMIN_SCHEMA = 1;
const PROFILE = 'default';

export type TxAdminSetup = {
    adminName: string;
    adminPassword: string;
    oneSync: 'on' | 'legacy' | 'off';
    serverName: string;
    language: string;
};

function writeIfMissing(file: string, content: string, label: string): void {
    if (fs.existsSync(file)) {
        log.skip(`${label} déjà présent, gardé tel quel`);
        return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o600 });
    log.ok(`${label} écrit`);
}

export function prepareTxAdmin(layout: Layout, setup: TxAdminSetup): void {
    const config = {
        version: TXADMIN_CONFIG_VERSION,
        general: {
            serverName: setup.serverName.replace(/[^ -~]/g, '').slice(0, 18) || 'Prax',
            language: setup.language,
        },
        server: {
            dataPath: layout.data,
            cfgPath: 'server.cfg',
            onesync: setup.oneSync,
            autoStart: true,
        },
    };
    writeIfMissing(path.join(layout.txData, PROFILE, 'config.json'), JSON.stringify(config, null, 4) + '\n', 'Profil txAdmin');

    const admins = [
        {
            $schema: TXADMIN_ADMIN_SCHEMA,
            name: setup.adminName,
            master: true,
            password_hash: bcrypt.hashSync(setup.adminPassword, 11),
            providers: {},
            permissions: [],
        },
    ];
    writeIfMissing(path.join(layout.txData, 'admins.json'), JSON.stringify(admins, null, 4) + '\n', 'Compte admin txAdmin');
}
