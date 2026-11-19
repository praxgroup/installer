import fs from 'node:fs';
import type { Layout } from './layout.ts';
import { readCfgValue } from './servercfg.ts';
import { readPrivateJson } from './state.ts';

const SECRET_DIRECTIVES = [
    'sv_licensekey',
    'rcon_password',
    'set steam_webApiKey',
    'set px:license',
    'set px:license_secret',
    'set px:guard_salt',
    'set px:bot_key',
    'set px:relay_key',
    'set px:discord_client_secret',
    'set px:coinshop_webhook',
];

const SECRET_PATTERNS: RegExp[] = [
    /cfxk_[A-Za-z0-9_]+/g,
    /PRAX-[0-9A-Z]{4}(?:-[0-9A-Z]{4}){3}/g,
    /\bpx[ids]_[A-Za-z0-9_-]{8,}/g,
    /(mysql:\/\/[^:\s"/]+:)[^@\s"]+@/g,
    /((?:password|pwd)=)[^;\s"]+/gi,
    /(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const MASK = '[masqué]';
const MIN_SECRET_LENGTH = 6;

function collectStrings(value: unknown, into: Set<string>): void {
    if (typeof value === 'string') {
        if (value.length >= MIN_SECRET_LENGTH) into.add(value);
        return;
    }
    if (Array.isArray(value)) value.forEach((item) => collectStrings(item, into));
    else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, into));
}

export class Redactor {
    private readonly values: string[];

    constructor(layout: Layout) {
        const found = new Set<string>();
        if (fs.existsSync(layout.serverCfg)) {
            const cfg = fs.readFileSync(layout.serverCfg, 'utf8');
            for (const key of SECRET_DIRECTIVES) {
                const value = readCfgValue(cfg, key);
                if (value && value.length >= MIN_SECRET_LENGTH && value !== 'none') found.add(value);
            }
            const connection = readCfgValue(cfg, 'set mysql_connection_string');
            if (connection) {
                const password = connection.match(/password=([^;]+)/i)?.[1] ?? connection.match(/mysql:\/\/[^:]+:([^@]+)@/)?.[1];
                if (password && password.length >= MIN_SECRET_LENGTH) {
                    found.add(password);
                    found.add(decodeURIComponent(password));
                }
            }
        }
        const local = readPrivateJson<Record<string, unknown>>(layout.localSecrets);
        if (local) collectStrings(local, found);
        this.values = [...found].filter((value) => !/^(127\.0\.0\.1|localhost|prax|root|%)$/.test(value)).sort((a, b) => b.length - a.length);
    }

    redact(text: string): string {
        let output = text;
        for (const value of this.values) output = output.split(value).join(MASK);
        for (const pattern of SECRET_PATTERNS) {
            output = output.replace(pattern, (_match, prefix?: string) => (typeof prefix === 'string' && prefix.length > 0 ? `${prefix}${MASK}${_match.endsWith('@') ? '@' : ''}` : MASK));
        }
        return output;
    }
}
