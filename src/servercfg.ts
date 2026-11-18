import fs from 'node:fs';
import path from 'node:path';

export type ServerCfgValues = {
    connectionString: string;
    gamePort: number;
    hostname: string;
    projectName: string;
    projectDescription: string;
    maxClients: number;
    cfxLicenseKey: string;
    steamWebApiKey: string;
    owners: string;
    discordClientId: string;
    discordClientSecret: string;
    botKey: string;
    rconPassword: string;
    oneSync: 'on' | 'legacy' | 'off';
};

type Directive = { key: string; render: (values: ServerCfgValues) => string };

export function hasDirective(cfg: string, key: string): boolean {
    return cfg.replace(/\r\n/g, '\n').split('\n').some((line) => directiveKey(line) === key);
}

function quote(value: string): string {
    return `"${value.replace(/["\r\n]/g, '')}"`;
}

const DIRECTIVES: Directive[] = [
    { key: 'set mysql_connection_string', render: (v) => `set mysql_connection_string ${quote(v.connectionString)}` },
    { key: 'endpoint_add_tcp', render: (v) => `endpoint_add_tcp "0.0.0.0:${v.gamePort}"` },
    { key: 'endpoint_add_udp', render: (v) => `endpoint_add_udp "0.0.0.0:${v.gamePort}"` },
    { key: 'sv_hostname', render: (v) => `sv_hostname ${quote(v.hostname)}` },
    { key: 'sets sv_projectName', render: (v) => `sets sv_projectName ${quote(v.projectName)}` },
    { key: 'sets sv_projectDesc', render: (v) => `sets sv_projectDesc ${quote(v.projectDescription)}` },
    { key: 'sv_maxclients', render: (v) => `sv_maxclients ${v.maxClients}` },
    { key: 'sv_licensekey', render: (v) => `sv_licensekey ${quote(v.cfxLicenseKey)}` },
    { key: 'set steam_webApiKey', render: (v) => `set steam_webApiKey ${quote(v.steamWebApiKey || 'none')}` },
    { key: 'set px:owners', render: (v) => `set px:owners ${quote(v.owners)}` },
    { key: 'set px:discord_client_id', render: (v) => `set px:discord_client_id ${quote(v.discordClientId)}` },
    { key: 'set px:discord_client_secret', render: (v) => `set px:discord_client_secret ${quote(v.discordClientSecret)}` },
    { key: 'set px:bot_key', render: (v) => `set px:bot_key ${quote(v.botKey)}` },
    { key: 'rcon_password', render: (v) => `rcon_password ${quote(v.rconPassword)}` },
    { key: 'set onesync', render: (v) => `set onesync ${v.oneSync}` },
];

const SET_COMMANDS = new Set(['set', 'sets', 'setr']);

function directiveKey(line: string): string | null {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return null;
    const tokens = trimmed.split(/\s+/);
    const command = tokens[0] ?? '';
    if (SET_COMMANDS.has(command) && tokens[1]) return `${command} ${tokens[1]}`;
    return command;
}

export function renderServerCfg(template: string, values: ServerCfgValues, dataDir: string, overrides: string[] = []): string {
    const lines = template.replace(/\r\n/g, '\n').split('\n');
    const pending = new Map<string, string>(DIRECTIVES.map((directive) => [directive.key, directive.render(values)]));
    for (const line of overrides) {
        const key = directiveKey(line);
        if (key) pending.set(key, line.trim());
    }
    const output: string[] = [];

    for (const line of lines) {
        if (line.trim().startsWith('#')) continue;
        const key = directiveKey(line);
        if (key === 'load_server_icon') {
            const icon = line.trim().split(/\s+/)[1]?.replace(/"/g, '') ?? '';
            if (!fs.existsSync(path.join(dataDir, icon))) continue;
        }
        const replacement = key ? pending.get(key) : undefined;
        if (key && replacement !== undefined) {
            output.push(replacement);
            pending.delete(key);
            continue;
        }
        output.push(line);
    }

    if (pending.size > 0) {
        const firstEnsure = output.findIndex((line) => directiveKey(line) === 'ensure');
        const at = firstEnsure === -1 ? output.length : firstEnsure;
        output.splice(at, 0, ...pending.values(), '');
    }

    return output.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
}

export function readCfgValue(cfg: string, key: string): string | null {
    for (const line of cfg.replace(/\r\n/g, '\n').split('\n')) {
        if (directiveKey(line) !== key) continue;
        const rest = line.trim().split(/\s+/).slice(key.split(' ').length).join(' ');
        return rest.replace(/^"(.*)"$/, '$1');
    }
    return null;
}
