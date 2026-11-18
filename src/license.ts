import fs from 'node:fs';
import { InstallError } from './log.ts';

export type LicensePlan = 'standard' | 'premium';

export type PremiumServices = {
    serverCfg: string[];
    hostedDatabase: boolean;
    panelUrl: string | null;
};

export type InstallLicense = {
    key: string;
    secret: string;
    plan: LicensePlan;
    label: string;
    premium: PremiumServices | null;
};

const LICENSE_KEY = /^PRAX-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

const PREMIUM_DIRECTIVES = new Set([
    'setr serverName',
    'set mysql_connection_string',
    'set px:panel_url',
    'set px:relay_url',
    'set px:relay_key',
    'set px:bot_key',
    'set px:discord_client_id',
    'set px:discord_client_secret',
    'set px:license',
    'set px:license_secret',
]);

const DIRECTIVE_LINE = /^(set|setr|sets) ([\w:.-]+) "((?:[^"\\\r\n;]|\\["\\])*)"$/;

function directiveKeyOf(line: string): string | null {
    const match = DIRECTIVE_LINE.exec(line.trim());
    return match ? `${match[1]} ${match[2]}` : null;
}

function quote(value: string): string {
    return `"${value.replace(/["\r\n]/g, '')}"`;
}

function checkPremiumLines(lines: unknown): string[] {
    if (!Array.isArray(lines)) throw new InstallError('Configuration premium invalide.');
    return lines.map((line) => {
        const text = String(line).trim();
        const key = directiveKeyOf(text);
        if (!key || !PREMIUM_DIRECTIVES.has(key)) {
            throw new InstallError(`Ligne de configuration premium refusée : ${text.split(' ').slice(0, 2).join(' ')}`, 'Mets à jour le programme prax, ou préviens le support Prax.');
        }
        return text;
    });
}

export function parseLicense(raw: unknown): InstallLicense {
    const data = raw as Record<string, unknown>;
    const license = data?.license as Record<string, unknown> | undefined;
    if (data?.format !== 1 || !license) throw new InstallError('Fichier de licence illisible ou trop récent.', 'Mets à jour le programme prax.');

    const key = String(license.key ?? '');
    const secret = String(license.secret ?? '');
    const plan = license.plan === 'premium' ? 'premium' : 'standard';
    if (!LICENSE_KEY.test(key)) throw new InstallError('Clé de licence Prax invalide dans le fichier.');
    if (secret.length < 16 || /["\r\n]/.test(secret)) throw new InstallError('Secret de licence invalide dans le fichier.');

    let premium: PremiumServices | null = null;
    if (plan === 'premium') {
        const services = data.premium as Record<string, unknown> | undefined;
        if (!services) throw new InstallError('Licence premium sans configuration de services.', 'Les services premium sont peut-être encore en préparation : regarde ton espace client.');
        const serverCfg = checkPremiumLines(services.serverCfg);
        premium = {
            serverCfg,
            hostedDatabase: serverCfg.some((line) => directiveKeyOf(line) === 'set mysql_connection_string'),
            panelUrl: typeof services.panelUrl === 'string' ? services.panelUrl : null,
        };
    }

    return { key, secret, plan, label: String(license.label ?? key), premium };
}

export function readLicenseFile(file: string): InstallLicense {
    if (!fs.existsSync(file)) throw new InstallError(`Fichier de licence introuvable : ${file}`);
    return parseLicense(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export type LicenseDirectiveOptions = {
    useHostedDatabase: boolean;
};

export function licenseDirectives(license: InstallLicense, options: LicenseDirectiveOptions): string[] {
    const lines = [`set px:license ${quote(license.key)}`, `set px:license_secret ${quote(license.secret)}`];
    if (!license.premium) return lines;
    for (const line of license.premium.serverCfg) {
        const key = directiveKeyOf(line);
        if (key === 'set px:license' || key === 'set px:license_secret') continue;
        if (key === 'set mysql_connection_string' && !options.useHostedDatabase) continue;
        lines.push(line);
    }
    return lines;
}
