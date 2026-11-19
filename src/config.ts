import fs from 'node:fs';
import path from 'node:path';
import { InstallError } from './log.ts';
import { cloneLua, Convar, Expression, formatLua, formatPath, Hash, loadConfig, LuaConfigError, LuaNumber, LuaTable, parseLuaValue, Vector } from './luaconfig.ts';
import type { LuaKey, LuaValue } from './luaconfig.ts';

export type Localized = { fr?: string; en?: string };

export type SchemaNode = {
    type: string | string[];
    fields?: Record<string, SchemaNode>;
    items?: SchemaNode;
    values?: SchemaNode | string[];
    removable?: boolean;
    optional?: boolean;
    min?: number;
    max?: number;
    label?: Localized;
    help?: Localized;
    restart?: boolean;
    convar?: string;
};

type IndexEntry = { name: string; side: 'shared' | 'server'; keys: string[] };
type SchemaFile = { format: number; config: string; keys: Record<string, SchemaNode> };

export type ConfigFile = {
    entry: IndexEntry;
    configFile: string;
    overrideFile: string;
    overrideRelative: string;
    schema: SchemaFile;
    defaults: LuaTable;
    overrides: LuaTable | null;
    overrideError: string | null;
    overrideHasComments: boolean;
};

export type ConfigWorkspace = {
    pcore: string;
    pconfig: string;
    files: ConfigFile[];
    defaults: LuaTable;
    merged: LuaTable;
};

const SUPPORTED_FORMAT = 1;
const ANY: SchemaNode = { type: 'any' };

const TYPE_LABELS: Record<string, string> = {
    bool: 'un booléen (true ou false)', number: 'un nombre', int: 'un nombre entier', money: 'un montant entier positif',
    blip: 'un numéro de blip', string: 'un texte', enum: 'une des valeurs permises', keybind: 'une touche',
    item: "un nom d'objet", job: 'un nom de métier', color: 'une couleur', vec2: 'un vec2', vec3: 'un vec3', vec4: 'un vec4',
    hash: 'un modèle (texte ou hash)', list: 'une liste', map: 'une table de clés', object: 'une table de réglages', any: 'une valeur',
};

const STRING_TYPES = new Set(['string', 'keybind', 'item', 'job', 'color', 'enum', 'hash']);

function readJson<T>(file: string): T {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch (error) {
        throw new InstallError(`Fichier illisible : ${file} (${(error as Error).message})`, 'Relance prax install pour remettre les fichiers de la base.');
    }
}

function mergeInto(target: LuaTable, overrides: LuaTable): void {
    for (const entry of overrides.entries) {
        const current = target.get(entry.key);
        if (entry.value === false && current instanceof LuaTable) {
            target.delete(entry.key);
        } else if (!(current instanceof LuaTable) || !(entry.value instanceof LuaTable) || current.isEmpty || current.isSequence) {
            target.set(entry.key, cloneLua(entry.value));
        } else {
            mergeInto(current, entry.value);
        }
    }
}

function mergeAll(defaults: LuaTable, files: ConfigFile[], replaced?: { file: ConfigFile; overrides: LuaTable }): LuaTable {
    const merged = cloneLua(defaults) as LuaTable;
    for (const side of ['shared', 'server']) {
        for (const file of files) {
            if (file.entry.side !== side) continue;
            const overrides = replaced?.file === file ? replaced.overrides : file.overrides;
            if (overrides) mergeInto(merged, overrides);
        }
    }
    return merged;
}

function loadOverrides(file: ConfigFile): void {
    if (!fs.existsSync(file.overrideFile)) return;
    const text = fs.readFileSync(file.overrideFile, 'utf8');
    if (!/\S/.test(text)) return;
    try {
        const loaded = loadConfig(text, file.overrideRelative);
        file.overrides = loaded.root;
        file.overrideHasComments = loaded.hasComments;
    } catch (error) {
        if (!(error instanceof LuaConfigError)) throw error;
        file.overrideError = error.message;
    }
}

export function resolveResources(dir: string, resources: string | undefined): string {
    if (resources) return path.resolve(resources);
    return path.join(path.resolve(dir), 'data', 'resources');
}

export function loadWorkspace(resources: string): ConfigWorkspace {
    const pcore = path.join(resources, 'pcore');
    const pconfig = path.join(resources, 'pconfig');
    const indexFile = path.join(pcore, 'schema', 'index.json');
    if (!fs.existsSync(indexFile)) {
        throw new InstallError(`Schéma de config introuvable : ${indexFile}`, 'Vérifie le dossier (--dir ou --resources) ; la base doit être en version 1.2 ou plus récente.');
    }
    const index = readJson<{ format: number; files: IndexEntry[] }>(indexFile);
    if (index.format !== SUPPORTED_FORMAT) throw new InstallError(`Format de schéma ${index.format} non pris en charge`, 'Mets à jour le programme prax.');

    const defaults = new LuaTable();
    const files: ConfigFile[] = [];
    for (const entry of index.files) {
        const sub = entry.side === 'server' ? 'server/' : '';
        const schema = readJson<SchemaFile>(path.join(pcore, 'schema', `${sub}${entry.name}.json`));
        const configFile = path.join(pcore, schema.config);
        let loaded;
        try {
            loaded = loadConfig(fs.readFileSync(configFile, 'utf8'), schema.config);
        } catch (error) {
            throw new InstallError(`Config de la base illisible : ${(error as Error).message}`, 'Relance prax install pour remettre les fichiers de la base.');
        }
        for (const key of entry.keys) {
            const value = loaded.root.get(key);
            if (value !== undefined) defaults.set(key, value);
        }
        const overrideRelative = `pconfig/${sub}${entry.name}.lua`;
        const file: ConfigFile = {
            entry,
            configFile,
            overrideFile: path.join(resources, overrideRelative),
            overrideRelative,
            schema,
            defaults: loaded.root,
            overrides: null,
            overrideError: null,
            overrideHasComments: false,
        };
        loadOverrides(file);
        files.push(file);
    }
    return { pcore, pconfig, files, defaults, merged: mergeAll(defaults, files) };
}

function typesOf(node: SchemaNode): string[] {
    return Array.isArray(node.type) ? node.type : [node.type ?? 'any'];
}

function hasType(node: SchemaNode, wanted: string): boolean {
    return typesOf(node).includes(wanted);
}

function enumValues(node: SchemaNode): string[] | null {
    return Array.isArray(node.values) ? node.values : null;
}

function childNode(node: SchemaNode | undefined, key: LuaKey): SchemaNode | undefined {
    if (!node) return undefined;
    if (hasType(node, 'any') && !node.fields && !node.items && !node.values) return ANY;
    if (node.fields && typeof key === 'string' && node.fields[key]) return node.fields[key];
    if (node.values && !Array.isArray(node.values)) return node.values;
    if (node.items && typeof key === 'number') return node.items;
    return undefined;
}

function isInteger(value: LuaValue): boolean {
    return value instanceof LuaNumber && Number.isInteger(value.value);
}

function convarFits(value: LuaValue, family: 'string' | 'number' | 'bool'): boolean {
    return value instanceof Convar && value.kind === family;
}

function matches(value: LuaValue | undefined, kind: string, node: SchemaNode): boolean {
    if (value === undefined) return false;
    if (value instanceof Expression) return true;
    switch (kind) {
        case 'any': return true;
        case 'bool': return typeof value === 'boolean' || convarFits(value, 'bool');
        case 'number': return value instanceof LuaNumber || convarFits(value, 'number');
        case 'int': case 'blip': return isInteger(value) || convarFits(value, 'number');
        case 'money': return (isInteger(value) && (value as LuaNumber).value >= 0) || convarFits(value, 'number');
        case 'string': case 'keybind': case 'item': case 'job': case 'color': return typeof value === 'string' || convarFits(value, 'string');
        case 'enum': return typeof value === 'string' && (enumValues(node)?.includes(value) ?? false);
        case 'vec2': case 'vec3': case 'vec4': return value instanceof Vector && value.size === Number(kind.slice(3));
        case 'hash': return typeof value === 'string' || value instanceof LuaNumber || value instanceof Hash;
        case 'list': return value instanceof LuaTable && (value.isEmpty || value.isSequence);
        case 'map': case 'object': return value instanceof LuaTable && (value.isEmpty || !value.isSequence);
        default: return false;
    }
}

function matchedType(value: LuaValue | undefined, node: SchemaNode): string | undefined {
    return typesOf(node).find((kind) => matches(value, kind, node));
}

export function describeValue(value: LuaValue | undefined): string {
    if (value === undefined || value === null) return 'rien';
    if (typeof value === 'string') return `"${value}"`;
    if (value instanceof LuaTable) return 'une table';
    if (value instanceof LuaNumber) return String(value.value);
    return formatLua(value, 0);
}

export function describeType(node: SchemaNode): string {
    const labels = typesOf(node).map((kind) => TYPE_LABELS[kind] ?? kind).join(' ou ');
    const allowed = enumValues(node);
    return allowed ? `${labels} parmi ${allowed.join(', ')}` : labels;
}

function where(base: string, key: LuaKey): string {
    return `${base}${formatPath(['', key])}`;
}

function validate(merged: LuaValue | undefined, override: LuaValue, node: SchemaNode, at: string, parent: SchemaNode | null, report: (message: string) => void): void {
    if (override === false && merged === undefined && !hasType(node, 'bool')) {
        const removable = (parent !== null && hasType(parent, 'map') && parent.removable !== false) || node.optional === true;
        if (!removable) report(`${at} ne peut pas être supprimé : donner une valeur à la place de false`);
        return;
    }
    const kind = matchedType(merged, node);
    if (!kind) {
        report(`${at} doit être ${describeType(node)} (reçu ${describeValue(merged)})`);
        return;
    }
    if (merged instanceof LuaNumber) {
        if (typeof node.min === 'number' && merged.value < node.min) report(`${at} doit valoir au moins ${node.min} (reçu ${merged.value})`);
        if (typeof node.max === 'number' && merged.value > node.max) report(`${at} doit valoir au plus ${node.max} (reçu ${merged.value})`);
    }
    if (!(override instanceof LuaTable) || !(merged instanceof LuaTable)) return;
    if (kind === 'object' && node.fields) {
        for (const entry of override.entries) {
            const field = typeof entry.key === 'string' ? node.fields[entry.key] : undefined;
            if (!field) report(`${where(at, entry.key)} : clé inconnue (faute de frappe, ou réglage retiré dans cette version)`);
            else validate(merged.get(entry.key), entry.value, field, where(at, entry.key), node, report);
        }
        for (const [key, field] of Object.entries(node.fields)) {
            if (!merged.has(key) && !field.optional && override.get(key) !== false) report(`${where(at, key)} manque`);
        }
    } else if (kind === 'map' && node.values && !Array.isArray(node.values)) {
        for (const entry of override.entries) validate(merged.get(entry.key), entry.value, node.values, where(at, entry.key), node, report);
    } else if (kind === 'list' && node.items) {
        for (const entry of override.entries) {
            if (typeof entry.key === 'number') validate(merged.get(entry.key), entry.value, node.items, `${at}[${entry.key}]`, node, report);
        }
    }
}

function ownerOf(workspace: ConfigWorkspace, key: string): ConfigFile | undefined {
    return workspace.files.find((file) => file.entry.keys.includes(key));
}

function validateOverrides(workspace: ConfigWorkspace, file: ConfigFile, overrides: LuaTable, merged: LuaTable): string[] {
    const problems: string[] = [];
    const report = (message: string): void => {
        problems.push(`${file.overrideRelative} : ${message}`);
    };
    for (const entry of overrides.entries) {
        const key = String(entry.key);
        const owner = ownerOf(workspace, key);
        const node = owner?.schema.keys[key];
        if (!owner) report(`Config.${key} : clé inconnue`);
        else if (!node) report(`Config.${key} : pas de schéma pour ce réglage`);
        else validate(merged.get(key), entry.value, node, `Config.${key}`, null, report);
    }
    return problems;
}

export type CheckResult = { problems: string[]; warnings: string[]; applied: string[] };

export function checkConfig(workspace: ConfigWorkspace): CheckResult {
    const problems: string[] = [];
    const warnings: string[] = [];
    const applied: string[] = [];
    const known = new Set<string>();
    for (const file of workspace.files) {
        known.add(path.resolve(file.overrideFile));
        if (file.overrideError) {
            warnings.push(`${file.overrideRelative} n'a pas pu être lu par prax config (${file.overrideError}) : s'il contient une erreur, pcore l'ignorera ; sinon il n'est vérifié qu'au démarrage du serveur`);
            continue;
        }
        if (!file.overrides || file.overrides.isEmpty) continue;
        applied.push(file.overrideRelative);
        problems.push(...validateOverrides(workspace, file, file.overrides, workspace.merged));
    }
    for (const stray of listLuaFiles(workspace.pconfig)) {
        if (known.has(path.resolve(stray)) || path.basename(stray) === 'fxmanifest.lua') continue;
        const relative = path.relative(path.dirname(workspace.pconfig), stray).replace(/\\/g, '/');
        warnings.push(`${relative} n'est pas lu par pcore : aucun fichier de config ne porte ce nom`);
    }
    return { problems, warnings, applied };
}

function listLuaFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name === 'server') found.push(...listLuaFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.lua')) found.push(full);
    }
    return found;
}

export function parseConfigPath(text: string): LuaKey[] {
    const source = text.trim().replace(/^Config\./, '');
    const keys: LuaKey[] = [];
    let index = 0;
    const fail = (): never => {
        throw new InstallError(`Chemin de réglage invalide : ${text}`, 'Exemples : Garage.transferFee, Config.Garage.garages["Pillbox Hill"].label, Shops.items[2]');
    };
    while (index < source.length) {
        const name = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (name) {
            keys.push(name[0]);
            index += name[0].length;
        } else if (source[index] === '[') {
            const bracket = source.slice(index).match(/^\[\s*(?:(-?\d+)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\]/);
            if (!bracket) fail();
            const [raw, number, double, single] = bracket as RegExpMatchArray;
            keys.push(number !== undefined ? Number(number) : (double ?? single ?? '').replace(/\\(.)/g, '$1'));
            index += raw.length;
        } else {
            fail();
        }
        if (index < source.length) {
            if (source[index] === '.') index++;
            else if (source[index] !== '[') fail();
        }
    }
    if (keys.length === 0 || typeof keys[0] !== 'string') fail();
    return keys;
}

function valueAt(root: LuaTable, keys: LuaKey[]): LuaValue | undefined {
    let current: LuaValue | undefined = root;
    for (const key of keys) {
        if (!(current instanceof LuaTable)) return undefined;
        current = current.get(key);
    }
    return current;
}

function nodeAt(workspace: ConfigWorkspace, keys: LuaKey[]): { file: ConfigFile; node: SchemaNode | undefined } {
    const top = String(keys[0]);
    const file = ownerOf(workspace, top);
    if (!file) {
        const names = workspace.files.flatMap((candidate) => candidate.entry.keys);
        const close = names.filter((name) => name.toLowerCase() === top.toLowerCase());
        throw new InstallError(`Réglage inconnu : Config.${top}`, close.length ? `Tu voulais dire Config.${close[0]} ?` : 'prax config get sans chemin liste les réglages de la base.');
    }
    let node: SchemaNode | undefined = file.schema.keys[top];
    for (const key of keys.slice(1)) node = childNode(node, key);
    return { file, node };
}

function sourceOf(file: ConfigFile, keys: LuaKey[], defaults: LuaTable, merged: LuaTable): 'pconfig' | 'défaut' {
    if (!file.overrides) return 'défaut';
    let current: LuaValue | undefined = file.overrides;
    for (const key of keys) {
        if (!(current instanceof LuaTable)) return 'défaut';
        if (current.isSequence && current !== file.overrides) return 'pconfig';
        current = current.get(key);
        if (current === undefined) break;
    }
    if (current !== undefined) return 'pconfig';
    return formatLua(valueAt(defaults, keys) ?? null, 0) === formatLua(valueAt(merged, keys) ?? null, 0) ? 'défaut' : 'pconfig';
}

export type ConfigEntry = {
    path: string;
    file: string;
    value: LuaValue | undefined;
    defaultValue: LuaValue | undefined;
    source: 'pconfig' | 'défaut';
    node: SchemaNode | undefined;
};

export function getEntry(workspace: ConfigWorkspace, text: string): ConfigEntry {
    const keys = parseConfigPath(text);
    const { file, node } = nodeAt(workspace, keys);
    const value = valueAt(workspace.merged, keys);
    const defaultValue = valueAt(workspace.defaults, keys);
    if (value === undefined && defaultValue === undefined && !node) {
        throw new InstallError(`Réglage inconnu : ${formatPath(['Config', ...keys])}`, `Regarde les clés de ${formatPath(['Config', ...keys.slice(0, -1)])}.`);
    }
    return {
        path: formatPath(['Config', ...keys]),
        file: file.overrideRelative,
        value,
        defaultValue,
        source: sourceOf(file, keys, workspace.defaults, workspace.merged),
        node,
    };
}

export function listTopLevel(workspace: ConfigWorkspace): { key: string; file: string; changed: boolean }[] {
    return workspace.files.flatMap((file) => file.entry.keys.map((key) => ({
        key,
        file: file.overrideRelative,
        changed: Boolean(file.overrides?.has(key)),
    })));
}

function hasExpression(value: LuaValue): boolean {
    if (value instanceof Expression) return true;
    return value instanceof LuaTable && value.entries.some((entry) => hasExpression(entry.value));
}

function parseCliValue(raw: string, node: SchemaNode | undefined): LuaValue {
    const target = node ?? ANY;
    let parsed: LuaValue | undefined;
    try {
        parsed = parseLuaValue(raw);
    } catch {
        parsed = undefined;
    }
    if (parsed !== undefined && hasExpression(parsed)) parsed = undefined;
    if (parsed !== undefined && (parsed === false || matchedType(parsed, target))) return parsed;
    const vector = typesOf(target).find((kind) => /^vec[234]$/.test(kind));
    if (vector) {
        const parts = raw.replace(/^vec(?:tor)?[234]\s*\(|\)$/g, '').split(',').map((part) => Number(part.trim()));
        if (parts.length === Number(vector.slice(3)) && parts.every((part) => Number.isFinite(part))) return new Vector(parts);
    }
    if (typesOf(target).some((kind) => STRING_TYPES.has(kind))) {
        if (matchedType(raw, target)) return raw;
    }
    if (parsed !== undefined) return parsed;
    throw new InstallError(`Valeur illisible : ${raw}`, node ? `Attendu : ${describeType(node)}. Une table s'écrit en Lua, par exemple { label = "Garage", price = 500 }.` : 'Une table s\'écrit en Lua, par exemple { label = "Garage", price = 500 }.');
}

function placeOverride(overrides: LuaTable, merged: LuaTable, keys: LuaKey[], value: LuaValue): void {
    let ovParent = overrides;
    let effParent: LuaTable | undefined = merged;
    keys.forEach((key, index) => {
        if (index === keys.length - 1) {
            ovParent.set(key, value);
            return;
        }
        const effChild: LuaValue | undefined = effParent?.get(key);
        let ovChild = ovParent.get(key);
        if (!(ovChild instanceof LuaTable)) {
            ovChild = effChild instanceof LuaTable && (effChild.isEmpty || effChild.isSequence) ? (cloneLua(effChild) as LuaTable) : new LuaTable();
            ovParent.set(key, ovChild);
        }
        ovParent = ovChild;
        effParent = effChild instanceof LuaTable ? effChild : undefined;
    });
}

function removeOverride(overrides: LuaTable, keys: LuaKey[], label: string): void {
    const chain: LuaTable[] = [overrides];
    let current = overrides;
    for (const [index, key] of keys.entries()) {
        if (index === keys.length - 1) break;
        const child = current.get(key);
        if (!(child instanceof LuaTable)) throw new InstallError(`${label} est déjà à sa valeur par défaut`);
        if (child.isSequence) {
            throw new InstallError(`${label} fait partie d'une liste remplacée en entier dans pconfig`, `Remets toute la liste par défaut avec prax config unset ${formatPath(['Config', ...keys.slice(0, index + 1)])}.`);
        }
        chain.push(child);
        current = child;
    }
    const last = keys[keys.length - 1] as LuaKey;
    if (!current.has(last)) throw new InstallError(`${label} est déjà à sa valeur par défaut`);
    current.delete(last);
    for (let depth = chain.length - 1; depth > 0; depth--) {
        const table = chain[depth] as LuaTable;
        if (!table.isEmpty) break;
        (chain[depth - 1] as LuaTable).delete(keys[depth - 1] as LuaKey);
    }
}

export function renderOverrides(overrides: LuaTable): string {
    return overrides.entries.map((entry) => `Config.${entry.key} = ${formatLua(entry.value, 0)}\n`).join('\n');
}

export type ChangeResult = { path: string; file: string; before: LuaValue | undefined; after: LuaValue | undefined; backup: string | null; removedFile: boolean };

function commit(workspace: ConfigWorkspace, file: ConfigFile, overrides: LuaTable, keys: LuaKey[], dryRun: boolean): ChangeResult {
    const label = formatPath(['Config', ...keys]);
    const merged = mergeAll(workspace.defaults, workspace.files, { file, overrides });
    const before = new Set(file.overrides ? validateOverrides(workspace, file, file.overrides, workspace.merged) : []);
    const after = validateOverrides(workspace, file, overrides, merged).filter((problem) => !before.has(problem));
    if (after.length > 0) {
        throw new InstallError(`Réglage refusé, rien n'a été écrit :\n${after.map((problem) => `    ${problem}`).join('\n')}`);
    }
    if (dryRun) {
        return {
            path: label,
            file: file.overrideRelative,
            before: valueAt(workspace.merged, keys),
            after: valueAt(merged, keys),
            backup: null,
            removedFile: overrides.isEmpty && fs.existsSync(file.overrideFile),
        };
    }
    let backup: string | null = null;
    if (file.overrideHasComments && fs.existsSync(file.overrideFile)) {
        backup = `${file.overrideFile}.bak`;
        fs.copyFileSync(file.overrideFile, backup);
    }
    let removedFile = false;
    if (overrides.isEmpty) {
        if (fs.existsSync(file.overrideFile)) {
            fs.rmSync(file.overrideFile);
            removedFile = true;
        }
    } else {
        fs.mkdirSync(path.dirname(file.overrideFile), { recursive: true });
        fs.writeFileSync(file.overrideFile, renderOverrides(overrides));
    }
    const result: ChangeResult = {
        path: label,
        file: file.overrideRelative,
        before: valueAt(workspace.merged, keys),
        after: valueAt(merged, keys),
        backup,
        removedFile,
    };
    file.overrides = overrides.isEmpty ? null : overrides;
    file.overrideHasComments = false;
    workspace.merged = merged;
    return result;
}

function editableOverrides(file: ConfigFile): LuaTable {
    if (file.overrideError) {
        throw new InstallError(`${file.overrideRelative} ne peut pas être modifié automatiquement : ${file.overrideError}`, 'Corrige ce fichier à la main, ou supprime-le pour repartir des valeurs par défaut.');
    }
    return file.overrides ? (cloneLua(file.overrides) as LuaTable) : new LuaTable();
}

export function setEntry(workspace: ConfigWorkspace, text: string, raw: string, dryRun = false): ChangeResult {
    const keys = parseConfigPath(text);
    const { file, node } = nodeAt(workspace, keys);
    const label = formatPath(['Config', ...keys]);
    if (!node) {
        throw new InstallError(`Réglage inconnu : ${label}`, `Regarde les clés existantes avec prax config get ${formatPath(['Config', ...keys.slice(0, -1)])}.`);
    }
    const value = parseCliValue(raw, node);
    const overrides = editableOverrides(file);
    placeOverride(overrides, workspace.merged, keys, value);
    return commit(workspace, file, overrides, keys, dryRun);
}

export function unsetEntry(workspace: ConfigWorkspace, text: string, dryRun = false): ChangeResult {
    const keys = parseConfigPath(text);
    const { file } = nodeAt(workspace, keys);
    const overrides = editableOverrides(file);
    removeOverride(overrides, keys, formatPath(['Config', ...keys]));
    return commit(workspace, file, overrides, keys, dryRun);
}

export type SearchHit = { path: string; file: string; type: string; label?: string; help?: string; score: number };

function fold(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function walkSchema(node: SchemaNode, keys: LuaKey[], visit: (node: SchemaNode, keys: LuaKey[]) => void, depth: number): void {
    visit(node, keys);
    if (depth > 6) return;
    if (node.fields) for (const [key, child] of Object.entries(node.fields)) walkSchema(child, [...keys, key], visit, depth + 1);
    if (node.items) walkSchema(node.items, [...keys, 1], visit, depth + 1);
    if (node.values && !Array.isArray(node.values)) walkSchema(node.values, [...keys, '<clé>'], visit, depth + 1);
}

export function searchSchema(workspace: ConfigWorkspace, query: string, limit = 15): SearchHit[] {
    const terms = fold(query).split(/[^a-z0-9_]+/).filter((term) => term.length >= 2);
    if (terms.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const file of workspace.files) {
        for (const [top, node] of Object.entries(file.schema.keys)) {
            walkSchema(node, [top], (current, keys) => {
                const path = formatPath(['Config', ...keys]);
                const labels = [current.label?.fr, current.label?.en].filter(Boolean).join(' ');
                const helps = [current.help?.fr, current.help?.en].filter(Boolean).join(' ');
                const inPath = fold(path);
                const inLabel = fold(labels);
                const inHelp = fold(helps);
                let score = 0;
                for (const term of terms) {
                    if (inPath.includes(term)) score += 3;
                    if (inLabel.includes(term)) score += 4;
                    if (inHelp.includes(term)) score += 1;
                }
                if (score === 0) return;
                hits.push({ path, file: file.overrideRelative, type: describeType(current), label: current.label?.fr, help: current.help?.fr, score: score - keys.length * 0.1 });
            }, 0);
        }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
