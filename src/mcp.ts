import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { checkConfig, describeType, getEntry, listTopLevel, loadWorkspace, searchSchema, setEntry, unsetEntry } from './config.ts';
import type { ChangeResult } from './config.ts';
import { collectFindings } from './doctor.ts';
import { installedBuild } from './fxserver.ts';
import { layoutOf } from './layout.ts';
import type { Layout } from './layout.ts';
import { InstallError } from './log.ts';
import { formatLua, LuaTable } from './luaconfig.ts';
import type { LuaValue } from './luaconfig.ts';
import { DEFAULT_GAME_PORT } from './platform.ts';
import { sendRcon } from './rcon.ts';
import { Redactor } from './secrets.ts';
import { readCfgValue } from './servercfg.ts';
import { InstallState, readPrivateJson } from './state.ts';
import { probeServer } from './system.ts';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DOCS_MCP = 'https://mcp.prax-studio.fr';
const LOG_TAIL_BYTES = 512 * 1024;
const MAX_LOG_LINES = 400;
const PREFIXED_RESOURCE = /^p[a-z0-9_-]{1,31}$/;

const INSTRUCTIONS = `Serveur MCP local de la base FiveM Prax, branché sur le serveur de l'utilisateur.
Pour régler la base :
1. config_search ou docs_search pour trouver le bon réglage, puis config_get pour lire sa valeur, son type et son aide ;
2. config_preview pour montrer à l'utilisateur ce qui va changer ;
3. config_set (ou config_unset) avec confirmed=true, seulement après son accord explicite ;
4. apply_changes pour recharger la base, après avoir prévenu que les joueurs connectés verront l'interface se recharger.
Les changements vont dans pconfig : le code de la base n'est jamais modifié et les mises à jour gardent ces réglages. Les montants sont en dollars du jeu, les durées dans l'unité indiquée par l'aide. En cas de problème au démarrage : doctor, puis logs_tail.
Les secrets (clés, mots de passe, jetons) sont masqués et ne doivent jamais être demandés à l'utilisateur dans la conversation.`;

type Args = Record<string, unknown>;
type Tool = {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: Record<string, boolean>;
    run: (args: Args) => Promise<string> | string;
};

type ServerContext = {
    layout: Layout;
    resources: string;
};

function stringArg(args: Args, name: string, required = true): string {
    const value = args[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (required) throw new InstallError(`Paramètre « ${name} » manquant`);
    return '';
}

function lua(value: LuaValue | undefined): string {
    return value === undefined ? 'absent' : formatLua(value, 0);
}

function describeChange(change: ChangeResult, written: boolean): string {
    const lines = [
        `${change.path} (${change.file})`,
        `avant : ${lua(change.before)}`,
        `après : ${lua(change.after)}`,
    ];
    if (!written) lines.push('Rien n\'a été écrit : c\'est un aperçu. Demande l\'accord de l\'utilisateur, puis appelle config_set ou config_unset avec confirmed=true.');
    else {
        if (change.removedFile) lines.push(`${change.file} a été retiré : il ne contenait plus aucun réglage.`);
        if (change.backup) lines.push(`Ce fichier contenait des commentaires, non gardés. Copie de l'ancien fichier : ${path.basename(change.backup)}.`);
        lines.push('Écrit dans pconfig. Appelle apply_changes pour l\'appliquer au serveur en marche (sinon : au prochain démarrage).');
    }
    return lines.join('\n');
}

function serverPort(layout: Layout): number {
    if (!fs.existsSync(layout.serverCfg)) return DEFAULT_GAME_PORT;
    const cfg = fs.readFileSync(layout.serverCfg, 'utf8');
    return Number(readCfgValue(cfg, 'endpoint_add_tcp')?.split(':').pop()) || DEFAULT_GAME_PORT;
}

function rconPassword(layout: Layout): string {
    const local = readPrivateJson<{ rconPassword?: string }>(layout.localSecrets);
    if (local?.rconPassword) return local.rconPassword;
    const cfg = fs.existsSync(layout.serverCfg) ? fs.readFileSync(layout.serverCfg, 'utf8') : '';
    const fromCfg = readCfgValue(cfg, 'rcon_password');
    if (!fromCfg) throw new InstallError('Aucun mot de passe RCON dans server.cfg', 'Relance prax install --reconfigure, ou redémarre le serveur depuis txAdmin.');
    return fromCfg;
}

function logFiles(layout: Layout): string[] {
    return [path.join(layout.txData, 'default', 'logs', 'fxserver.log'), layout.serverLog].filter((file) => fs.existsSync(file));
}

function tailFile(file: string, lines: number, contains: string): string[] {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    fs.closeSync(handle);
    const all = buffer.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').replace(/\^\d/g, '').split(/\r?\n/).filter((line) => line.trim() !== '');
    const filtered = contains ? all.filter((line) => line.toLowerCase().includes(contains.toLowerCase())) : all;
    return filtered.slice(-lines);
}

async function callDocs(tool: string, args: Args): Promise<string> {
    const response = await fetch(DOCS_MCP, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'prax-installer' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new InstallError(`Documentation injoignable (${response.status})`, `Elle reste lisible sur https://prax-studio.fr/docs`);
    const body = (await response.json()) as { result?: { content?: { text?: string }[] }; error?: { message?: string } };
    if (body.error) throw new InstallError(`Documentation : ${body.error.message ?? 'erreur'}`);
    return (body.result?.content ?? []).map((part) => part.text ?? '').join('\n').replace(/get_config_reference path=/g, 'config_get path=').replace(/\bget_guide\b/g, 'docs_guide');
}

function tools(context: ServerContext): Tool[] {
    const workspace = () => loadWorkspace(context.resources);
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    const pathInput = { type: 'string', description: 'Chemin du réglage, par exemple Garage.transferFee ou Garage.garages["Pillbox Hill"].label' };

    return [
        {
            name: 'server_status',
            title: 'État du serveur',
            description: 'Dit si le serveur FiveM tourne, sur quel port, avec quelles ressources Prax, et quelles versions de FXServer et de la base sont installées.',
            inputSchema: { type: 'object', properties: {} },
            annotations: readOnly,
            run: async () => {
                const port = serverPort(context.layout);
                const info = await probeServer(port);
                const base = new InstallState(context.layout.state).details('base');
                const lines = [
                    `Dossier : ${context.layout.root}`,
                    `Base Prax : ${base.version ?? 'version inconnue'}`,
                    `FXServer : ${installedBuild(context.layout) ?? 'non installé'}`,
                    info ? `Serveur en ligne sur le port ${port}` : `Serveur à l'arrêt (aucune réponse sur le port ${port})`,
                ];
                if (info) lines.push(`Ressources Prax démarrées : ${info.resources.filter((name) => PREFIXED_RESOURCE.test(name)).join(', ') || 'aucune'}`);
                return lines.join('\n');
            },
        },
        {
            name: 'doctor',
            title: 'Diagnostic',
            description: 'Cherche ce qui empêche le serveur de démarrer ou de bien tourner : fichiers de la base, FXServer, server.cfg, réglages de pconfig, ressources démarrées. Donne pour chaque problème la correction à faire.',
            inputSchema: { type: 'object', properties: {} },
            annotations: readOnly,
            run: async () => {
                const { findings } = await collectFindings(context.layout.root);
                const problems = findings.filter((finding) => !finding.ok);
                const lines = findings.map((finding) => `${finding.ok ? '[ok]' : '[problème]'} ${finding.text}${finding.fix ? ` → ${finding.fix}` : ''}`);
                lines.push(problems.length === 0 ? 'Aucun problème trouvé.' : `${problems.length} problème(s).`);
                return lines.join('\n');
            },
        },
        {
            name: 'config_list',
            title: 'Liste des réglages',
            description: 'Liste les réglages de premier niveau de la base (Config.Garage, Config.Economy…), avec le fichier pconfig de chacun et ceux déjà modifiés.',
            inputSchema: { type: 'object', properties: {} },
            annotations: readOnly,
            run: () => listTopLevel(workspace()).map((entry) => `${entry.changed ? '* ' : '  '}Config.${entry.key} (${entry.file})`).join('\n') + '\n* : modifié dans pconfig',
        },
        {
            name: 'config_search',
            title: 'Chercher un réglage',
            description: 'Cherche un réglage par mots-clés dans les chemins, libellés et aides du schéma (en français ou en anglais). À utiliser avant config_get quand on ne connaît pas le chemin exact.',
            inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Mots-clés, par exemple « prix transfert garage »' } }, required: ['query'] },
            annotations: readOnly,
            run: (args) => {
                const hits = searchSchema(workspace(), stringArg(args, 'query'));
                if (hits.length === 0) return 'Aucun réglage trouvé. Essaie d\'autres mots, ou docs_search pour chercher dans les guides.';
                return hits.map((hit) => `${hit.path} — ${hit.label ?? 'sans libellé'} (${hit.type})${hit.help ? `\n    ${hit.help}` : ''}`).join('\n');
            },
        },
        {
            name: 'config_get',
            title: 'Lire un réglage',
            description: 'Donne la valeur actuelle d\'un réglage, sa valeur par défaut, d\'où vient la valeur (défaut ou pconfig), son type, ses bornes, son libellé et son aide.',
            inputSchema: { type: 'object', properties: { path: pathInput }, required: ['path'] },
            annotations: readOnly,
            run: (args) => {
                const entry = getEntry(workspace(), stringArg(args, 'path'));
                const lines = [`${entry.path}`, `valeur : ${lua(entry.value)}`, `source : ${entry.source === 'pconfig' ? entry.file : 'valeur par défaut de la base'}`];
                if (entry.source === 'pconfig') lines.push(`défaut : ${lua(entry.defaultValue)}`);
                if (entry.node) {
                    lines.push(`type : ${describeType(entry.node)}`);
                    if (entry.node.label?.fr) lines.push(`libellé : ${entry.node.label.fr}`);
                    if (entry.node.help?.fr) lines.push(`aide : ${entry.node.help.fr}`);
                    if (typeof entry.node.min === 'number' || typeof entry.node.max === 'number') lines.push(`bornes : ${entry.node.min ?? '-∞'} à ${entry.node.max ?? '+∞'}`);
                    if (entry.node.convar) lines.push(`réglé dans server.cfg par la convar ${entry.node.convar} : pas modifiable ici`);
                }
                if (entry.value instanceof LuaTable && !entry.value.isEmpty && !entry.value.isSequence) {
                    lines.push(`clés : ${entry.value.entries.map((item) => String(item.key)).join(', ')}`);
                }
                lines.push(`fichier de réglages : ${entry.file}`);
                return lines.join('\n');
            },
        },
        {
            name: 'config_preview',
            title: 'Aperçu d\'un changement',
            description: 'Vérifie un changement avec le schéma et montre la valeur avant et après, sans rien écrire. Donner value pour modifier, ou unset=true pour revenir à la valeur par défaut. Une table s\'écrit en Lua : { label = "Garage", price = 500 }, un vecteur : vec3(1.0, 2.0, 3.0).',
            inputSchema: {
                type: 'object',
                properties: {
                    path: pathInput,
                    value: { type: 'string', description: 'Nouvelle valeur, en Lua (nombre, "texte", true, { … }, vec3(…))' },
                    unset: { type: 'boolean', description: 'true pour revenir à la valeur par défaut' },
                },
                required: ['path'],
            },
            annotations: readOnly,
            run: (args) => {
                const target = stringArg(args, 'path');
                const change = args.unset === true ? unsetEntry(workspace(), target, true) : setEntry(workspace(), target, stringArg(args, 'value'), true);
                return describeChange(change, false);
            },
        },
        {
            name: 'config_set',
            title: 'Modifier un réglage',
            description: 'Écrit un réglage dans pconfig après l\'avoir vérifié avec le schéma. Le code de la base n\'est jamais touché. Montrer d\'abord le changement avec config_preview, et ne mettre confirmed=true qu\'après l\'accord explicite de l\'utilisateur.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: pathInput,
                    value: { type: 'string', description: 'Nouvelle valeur, en Lua' },
                    confirmed: { type: 'boolean', description: 'true seulement si l\'utilisateur a accepté ce changement' },
                },
                required: ['path', 'value', 'confirmed'],
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            run: (args) => {
                if (args.confirmed !== true) throw new InstallError('Changement non confirmé : montre-le avec config_preview et demande l\'accord de l\'utilisateur');
                return describeChange(setEntry(workspace(), stringArg(args, 'path'), stringArg(args, 'value')), true);
            },
        },
        {
            name: 'config_unset',
            title: 'Remettre un réglage par défaut',
            description: 'Retire un réglage de pconfig : il reprend la valeur par défaut de la base. Ne mettre confirmed=true qu\'après l\'accord explicite de l\'utilisateur.',
            inputSchema: {
                type: 'object',
                properties: { path: pathInput, confirmed: { type: 'boolean', description: 'true seulement si l\'utilisateur a accepté' } },
                required: ['path', 'confirmed'],
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            run: (args) => {
                if (args.confirmed !== true) throw new InstallError('Changement non confirmé : montre-le avec config_preview et demande l\'accord de l\'utilisateur');
                return describeChange(unsetEntry(workspace(), stringArg(args, 'path')), true);
            },
        },
        {
            name: 'config_check',
            title: 'Vérifier les réglages',
            description: 'Vérifie tous les réglages de pconfig avec le schéma, comme pcore le fait au démarrage.',
            inputSchema: { type: 'object', properties: {} },
            annotations: readOnly,
            run: () => {
                const result = checkConfig(workspace());
                const lines = [result.applied.length ? `Fichiers lus : ${result.applied.join(', ')}` : 'Aucun réglage dans pconfig : la base tourne avec ses valeurs par défaut.'];
                lines.push(...result.warnings.map((warning) => `[avertissement] ${warning}`), ...result.problems.map((problem) => `[problème] ${problem}`));
                lines.push(result.problems.length === 0 ? 'Réglages valides.' : `${result.problems.length} problème(s).`);
                return lines.join('\n');
            },
        },
        {
            name: 'logs_tail',
            title: 'Derniers journaux du serveur',
            description: 'Lit les dernières lignes de la console du serveur (journal de txAdmin, ou celui du lancement par prax). Les secrets sont masqués.',
            inputSchema: {
                type: 'object',
                properties: {
                    lines: { type: 'integer', minimum: 1, maximum: MAX_LOG_LINES, description: 'Nombre de lignes (80 par défaut)' },
                    contains: { type: 'string', description: 'Ne garder que les lignes qui contiennent ce texte, par exemple « [pcore] » ou « error »' },
                },
            },
            annotations: readOnly,
            run: (args) => {
                const files = logFiles(context.layout);
                if (files.length === 0) return 'Aucun journal trouvé : le serveur n\'a pas encore été lancé par txAdmin ou par prax. Sous Windows sans txAdmin, la console n\'est que dans la fenêtre du serveur.';
                const newest = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] as string;
                const count = Math.min(MAX_LOG_LINES, Math.max(1, Number(args.lines) || 80));
                const lines = tailFile(newest, count, stringArg(args, 'contains', false));
                return lines.length ? lines.join('\n') : 'Aucune ligne ne correspond.';
            },
        },
        {
            name: 'apply_changes',
            title: 'Appliquer les réglages au serveur',
            description: 'Recharge pconfig puis redémarre pcore par la console du serveur (RCON), pour appliquer les réglages sans redémarrer tout le serveur. Les joueurs connectés voient l\'interface se recharger : prévenir l\'utilisateur avant.',
            inputSchema: { type: 'object', properties: { confirmed: { type: 'boolean', description: 'true seulement si l\'utilisateur a accepté le rechargement' } }, required: ['confirmed'] },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            run: async (args) => {
                if (args.confirmed !== true) throw new InstallError('Rechargement non confirmé : préviens l\'utilisateur et demande son accord');
                const port = serverPort(context.layout);
                if (!(await probeServer(port))) return `Le serveur est à l'arrêt (port ${port}) : les réglages s'appliqueront au prochain démarrage.`;
                const password = rconPassword(context.layout);
                const outputs: string[] = [];
                for (const command of ['refresh', 'ensure pconfig', 'ensure pcore', 'ensure pguard']) {
                    const output = await sendRcon(port, password, command).catch((error: Error) => `erreur : ${error.message}`);
                    outputs.push(`> ${command}${output ? `\n${output}` : ''}`);
                }
                outputs.push('Regarde logs_tail avec contains="[pcore] config" pour vérifier que les réglages sont acceptés.');
                return outputs.join('\n');
            },
        },
        {
            name: 'docs_search',
            title: 'Chercher dans la documentation Prax',
            description: 'Cherche dans les guides et la référence publics de la base Prax (installation, réglages, dépannage, hébergeurs).',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            annotations: { readOnlyHint: true, openWorldHint: true },
            run: (args) => callDocs('search_docs', { query: stringArg(args, 'query') }),
        },
        {
            name: 'docs_guide',
            title: 'Lire un guide Prax',
            description: 'Lit un guide de la documentation Prax en entier, à partir de son identifiant (slug) donné par docs_search.',
            inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
            annotations: { readOnlyHint: true, openWorldHint: true },
            run: (args) => callDocs('get_guide', { slug: stringArg(args, 'slug') }),
        },
    ];
}

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

function send(message: unknown): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function runMcp(dir: string, resources: string | undefined, version: string): Promise<number> {
    const layout = layoutOf(dir);
    const context: ServerContext = { layout, resources: resources ? path.resolve(resources) : layout.resources };
    const catalog = tools(context);

    async function handle(message: RpcMessage): Promise<unknown> {
        const params = message.params ?? {};
        switch (message.method) {
            case 'initialize': {
                const requested = String(params.protocolVersion ?? '');
                return {
                    protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'prax', title: 'Serveur Prax', version },
                    instructions: INSTRUCTIONS,
                };
            }
            case 'ping':
                return {};
            case 'tools/list':
                return { tools: catalog.map(({ run: _run, ...tool }) => tool) };
            case 'tools/call': {
                const tool = catalog.find((candidate) => candidate.name === params.name);
                if (!tool) throw Object.assign(new Error(`Outil inconnu : ${String(params.name)}`), { code: -32602 });
                const redactor = new Redactor(layout);
                try {
                    const text = await tool.run((params.arguments as Args | undefined) ?? {});
                    return { content: [{ type: 'text', text: redactor.redact(text) }] };
                } catch (error) {
                    const reason = error instanceof InstallError ? `${error.message}${error.hint ? `\n→ ${error.hint}` : ''}` : `Erreur inattendue : ${(error as Error).message}`;
                    return { content: [{ type: 'text', text: redactor.redact(reason) }], isError: true };
                }
            }
            default:
                throw Object.assign(new Error(`Méthode inconnue : ${String(message.method)}`), { code: -32601 });
        }
    }

    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
        if (!line.trim()) continue;
        let message: RpcMessage;
        try {
            message = JSON.parse(line) as RpcMessage;
        } catch {
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON invalide' } });
            continue;
        }
        const isRequest = message.id !== undefined && message.id !== null;
        if (!message.method) continue;
        if (!isRequest) continue;
        try {
            send({ jsonrpc: '2.0', id: message.id, result: await handle(message) });
        } catch (error) {
            const code = (error as { code?: number }).code ?? -32603;
            send({ jsonrpc: '2.0', id: message.id, error: { code, message: (error as Error).message } });
        }
    }
    return 0;
}
