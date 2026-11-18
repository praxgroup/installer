export class Vector {
    readonly values: number[];
    constructor(values: number[]) {
        this.values = values;
    }
    get size(): number {
        return this.values.length;
    }
}

export class Hash {
    readonly name: string;
    constructor(name: string) {
        this.name = name;
    }
}

export class Convar {
    readonly call: string;
    readonly name: string;
    readonly fallback: LuaValue;
    readonly kind: 'string' | 'number' | 'bool';
    constructor(call: string, name: string, fallback: LuaValue, kind: 'string' | 'number' | 'bool') {
        this.call = call;
        this.name = name;
        this.fallback = fallback;
        this.kind = kind;
    }
}

export class LuaNumber {
    readonly value: number;
    readonly integer: boolean;
    constructor(value: number, integer: boolean) {
        this.value = value;
        this.integer = integer;
    }
}

export class Expression {
    readonly source: string;
    constructor(source: string) {
        this.source = source;
    }
}

export type LuaKey = string | number;
export type LuaEntry = { key: LuaKey; value: LuaValue };
export type LuaValue = null | boolean | string | LuaNumber | Vector | Hash | Convar | Expression | LuaTable;

export class LuaTable {
    entries: LuaEntry[] = [];

    get isSequence(): boolean {
        return this.entries.length > 0 && this.entries.every((entry, index) => entry.key === index + 1);
    }

    get isEmpty(): boolean {
        return this.entries.length === 0;
    }

    has(key: LuaKey): boolean {
        return this.entries.some((entry) => entry.key === key);
    }

    get(key: LuaKey): LuaValue | undefined {
        return this.entries.find((entry) => entry.key === key)?.value;
    }

    set(key: LuaKey, value: LuaValue): void {
        const found = this.entries.find((entry) => entry.key === key);
        if (found) found.value = value;
        else this.entries.push({ key, value });
    }

    delete(key: LuaKey): void {
        this.entries = this.entries.filter((entry) => entry.key !== key);
    }
}

type Token = { kind: 'string' | 'hash' | 'number' | 'name' | 'symbol' | 'end'; value: string; number?: LuaNumber; line: number };

const VECTOR_CALLS = new Set(['vec2', 'vec3', 'vec4', 'vector2', 'vector3', 'vector4']);
const CONVAR_CALLS: Record<string, 'string' | 'number' | 'bool'> = { GetConvar: 'string', GetConvarInt: 'number', GetConvarFloat: 'number', GetConvarBool: 'bool' };
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };

export class LuaConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LuaConfigError';
    }
}

function tokenize(text: string, file: string): { tokens: Token[]; hasComments: boolean } {
    const tokens: Token[] = [];
    let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    let line = 1;
    let hasComments = false;
    const fail = (message: string): never => {
        throw new LuaConfigError(`${file}:${line} : ${message}`);
    };
    while (index < text.length) {
        const char = text[index] ?? '';
        if (char === '\n') {
            line++;
            index++;
            continue;
        }
        if (/\s/.test(char)) {
            index++;
            continue;
        }
        if (char === '-' && text[index + 1] === '-') {
            hasComments = true;
            const long = text.slice(index + 2).match(/^\[(=*)\[/);
            if (long) {
                const close = `]${long[1]}]`;
                const end = text.indexOf(close, index);
                if (end === -1) fail('commentaire non fermé');
                line += (text.slice(index, end).match(/\n/g) ?? []).length;
                index = end + close.length;
            } else {
                const end = text.indexOf('\n', index);
                index = end === -1 ? text.length : end;
            }
            continue;
        }
        const longString = char === '[' ? text.slice(index).match(/^\[(=*)\[/) : null;
        if (longString) {
            const close = `]${longString[1]}]`;
            const start = index + longString[0].length;
            const end = text.indexOf(close, start);
            if (end === -1) fail('chaîne longue non fermée');
            let value = text.slice(start, end);
            if (value.startsWith('\r\n')) value = value.slice(2);
            else if (value.startsWith('\n')) value = value.slice(1);
            tokens.push({ kind: 'string', value, line });
            line += (text.slice(index, end).match(/\n/g) ?? []).length;
            index = end + close.length;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            let end = index + 1;
            let value = '';
            while (end < text.length && text[end] !== char) {
                if (text[end] === '\n') fail('chaîne non fermée');
                if (text[end] === '\\') {
                    const escaped = text[end + 1] ?? '';
                    const mapped = ESCAPES[escaped];
                    if (mapped !== undefined) {
                        value += mapped;
                        end += 2;
                        continue;
                    }
                    const digits = text.slice(end + 1).match(/^[0-9]{1,3}/);
                    if (digits) {
                        value += String.fromCharCode(Number(digits[0]));
                        end += 1 + digits[0].length;
                        continue;
                    }
                    value += escaped;
                    end += 2;
                    continue;
                }
                value += text[end++];
            }
            if (end >= text.length) fail('chaîne non fermée');
            tokens.push({ kind: char === '`' ? 'hash' : 'string', value, line });
            index = end + 1;
            continue;
        }
        const number = text.slice(index).match(/^(0[xX][0-9a-fA-F]+|[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)/);
        if (number) {
            const raw = number[0];
            const integer = !/[.eE]/.test(raw) || /^0[xX]/.test(raw);
            tokens.push({ kind: 'number', value: raw, number: new LuaNumber(Number(raw), integer), line });
            index += raw.length;
            continue;
        }
        const name = text.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (name) {
            tokens.push({ kind: 'name', value: name[0], line });
            index += name[0].length;
            continue;
        }
        tokens.push({ kind: 'symbol', value: char, line });
        index++;
    }
    tokens.push({ kind: 'end', value: '<fin>', line });
    return { tokens, hasComments };
}

type Assignment = { target: LuaKey[]; value: LuaValue; line: number; isDefault: boolean };

function parse(text: string, file: string): { assignments: Assignment[]; hasComments: boolean } {
    const { tokens, hasComments } = tokenize(text, file);
    let position = 0;
    const peek = (): Token => tokens[position] as Token;
    const take = (): Token => tokens[position++] as Token;
    const fail = (message: string, token: Token = peek()): never => {
        throw new LuaConfigError(`${file}:${token.line} : ${message} (reçu « ${token.value} »)`);
    };
    const isSymbol = (value: string, token: Token | undefined = peek()): boolean => token?.kind === 'symbol' && token.value === value;
    const expectSymbol = (value: string): Token => {
        if (!isSymbol(value)) fail(`« ${value} » attendu`);
        return take();
    };

    function asKey(value: LuaValue): LuaKey {
        if (typeof value === 'string') return value;
        if (value instanceof LuaNumber) return value.value;
        if (typeof value === 'boolean') return String(value);
        return fail('clé de table non prise en charge');
    }

    function parseCallArgs(): LuaValue[] {
        expectSymbol('(');
        const args: LuaValue[] = [];
        while (!isSymbol(')')) {
            args.push(parseExpression());
            if (isSymbol(',')) take();
            else if (!isSymbol(')')) fail('« , » ou « ) » attendu');
        }
        take();
        return args;
    }

    function parseTable(): LuaTable {
        expectSymbol('{');
        const table = new LuaTable();
        let nextIndex = 1;
        while (!isSymbol('}')) {
            const token = peek();
            let key: LuaKey;
            if (isSymbol('[')) {
                take();
                key = asKey(parseExpression());
                expectSymbol(']');
                expectSymbol('=');
            } else if (token.kind === 'name' && isSymbol('=', tokens[position + 1])) {
                key = token.value;
                position += 2;
            } else {
                key = nextIndex++;
            }
            table.set(key, parseExpression());
            if (isSymbol(',') || isSymbol(';')) take();
            else if (!isSymbol('}')) fail('« , » ou « } » attendu');
        }
        take();
        return table;
    }

    function parsePrimary(): LuaValue {
        const token = peek();
        if (token.kind === 'string') {
            take();
            return token.value;
        }
        if (token.kind === 'number' && token.number) {
            take();
            return token.number;
        }
        if (token.kind === 'hash') {
            take();
            return new Hash(token.value);
        }
        if (isSymbol('{')) return parseTable();
        if (isSymbol('-')) {
            take();
            const value = parsePrimary();
            if (value instanceof LuaNumber) return new LuaNumber(-value.value, value.integer);
            return fail('nombre attendu après « - »');
        }
        if (token.kind === 'name') {
            if (token.value === 'true') {
                take();
                return true;
            }
            if (token.value === 'false') {
                take();
                return false;
            }
            if (token.value === 'nil') {
                take();
                return null;
            }
            take();
            let name = token.value;
            while (isSymbol('.')) {
                take();
                name += '.' + take().value;
            }
            if (isSymbol('(')) {
                const args = parseCallArgs();
                if (VECTOR_CALLS.has(name)) {
                    if (!args.every((arg) => arg instanceof LuaNumber)) fail('un vecteur ne prend que des nombres', token);
                    return new Vector(args.map((arg) => (arg as LuaNumber).value));
                }
                const kind = CONVAR_CALLS[name];
                if (kind && typeof args[0] === 'string') return new Convar(name, args[0], args[1] ?? null, kind);
                return fail(`appel de fonction non pris en charge dans une config : ${name}`, token);
            }
            return new Expression(name);
        }
        return fail('valeur attendue');
    }

    function parseExpression(): LuaValue {
        const left = parsePrimary();
        if (peek().kind === 'name' && (peek().value === 'or' || peek().value === 'and')) {
            let source = left instanceof Expression ? left.source : formatLua(left, 0);
            while (peek().kind === 'name' && (peek().value === 'or' || peek().value === 'and')) {
                const operator = take().value;
                const right = parsePrimary();
                source += ` ${operator} ${right instanceof Expression ? right.source : formatLua(right, 0)}`;
            }
            return new Expression(source);
        }
        return left;
    }

    const assignments: Assignment[] = [];
    while (peek().kind !== 'end') {
        if (isSymbol(';')) {
            take();
            continue;
        }
        const start = peek();
        if (start.kind !== 'name') fail('affectation attendue');
        if (start.value === 'local') fail('variable locale non prise en charge');
        const target: LuaKey[] = [take().value];
        while (isSymbol('.') || isSymbol('[')) {
            if (isSymbol('.')) {
                take();
                target.push(take().value);
            } else {
                take();
                target.push(asKey(parseExpression()));
                expectSymbol(']');
            }
        }
        expectSymbol('=');
        const value = parseExpression();
        const isDefault = target.length === 1 && value instanceof Expression && value.source === 'Config or {}';
        assignments.push({ target, value, line: start.line, isDefault });
    }
    return { assignments, hasComments };
}

export type LoadedConfig = { root: LuaTable; keys: string[]; hasComments: boolean };

export function loadConfig(text: string, file: string): LoadedConfig {
    const root = new LuaTable();
    const keys: string[] = [];
    const { assignments, hasComments } = parse(text, file);
    for (const assignment of assignments) {
        const [head, ...rest] = assignment.target;
        if (head !== 'Config') throw new LuaConfigError(`${file}:${assignment.line} : seule la table Config peut être affectée`);
        if (rest.length === 0) {
            if (!assignment.isDefault && !(assignment.value instanceof LuaTable && assignment.value.isEmpty)) {
                throw new LuaConfigError(`${file}:${assignment.line} : Config ne peut être que « Config = Config or {} »`);
            }
            continue;
        }
        let parent = root;
        for (const key of rest.slice(0, -1)) {
            let child = parent.get(key);
            if (!(child instanceof LuaTable)) {
                child = new LuaTable();
                parent.set(key, child);
            }
            parent = child;
        }
        const key = rest[rest.length - 1] as LuaKey;
        parent.set(key, assignment.value);
        if (parent === root && typeof key === 'string' && !keys.includes(key)) keys.push(key);
    }
    return { root, keys, hasComments };
}

export function parseLuaValue(text: string): LuaValue {
    const loaded = loadConfig(`Config.value = ${text}`, 'valeur');
    const value = loaded.root.get('value');
    return value === undefined ? null : value;
}

export function cloneLua(value: LuaValue): LuaValue {
    if (!(value instanceof LuaTable)) return value;
    const copy = new LuaTable();
    for (const entry of value.entries) copy.entries.push({ key: entry.key, value: cloneLua(entry.value) });
    return copy;
}

const RESERVED = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);
const INDENT = '    ';
const INLINE_LIMIT = 80;

export function isIdentifier(key: LuaKey): key is string {
    return typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !RESERVED.has(key);
}

function quoteLua(text: string): string {
    let result = '"';
    for (const char of text) {
        const code = char.charCodeAt(0);
        if (char === '\\') result += '\\\\';
        else if (char === '"') result += '\\"';
        else if (char === '\n') result += '\\n';
        else if (char === '\r') result += '\\r';
        else if (char === '\t') result += '\\t';
        else if (code < 32) result += `\\${code}`;
        else result += char;
    }
    return result + '"';
}

function formatNumber(value: number, integer: boolean): string {
    if (integer || !Number.isInteger(value)) return String(value);
    return `${value}.0`;
}

export function formatKey(key: LuaKey): string {
    if (isIdentifier(key)) return key;
    return typeof key === 'number' ? `[${key}]` : `[${quoteLua(key)}]`;
}

export function formatLua(value: LuaValue, depth: number): string {
    if (value === null) return 'nil';
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'string') return quoteLua(value);
    if (value instanceof LuaNumber) return formatNumber(value.value, value.integer);
    if (value instanceof Vector) return `vec${value.size}(${value.values.map((part) => formatNumber(part, false)).join(', ')})`;
    if (value instanceof Hash) return `\`${value.name}\``;
    if (value instanceof Convar) return `${value.call}(${quoteLua(value.name)}${value.fallback === null ? '' : `, ${formatLua(value.fallback, depth)}`})`;
    if (value instanceof Expression) return value.source;
    if (value.isEmpty) return '{}';
    const sequence = value.isSequence;
    const parts = value.entries.map((entry) => (sequence ? formatLua(entry.value, depth + 1) : `${formatKey(entry.key)} = ${formatLua(entry.value, depth + 1)}`));
    const inline = `{ ${parts.join(', ')} }`;
    const nested = value.entries.some((entry) => entry.value instanceof LuaTable && !entry.value.isEmpty);
    if (!nested && !inline.includes('\n') && inline.length + depth * INDENT.length <= INLINE_LIMIT) return inline;
    const inner = INDENT.repeat(depth + 1);
    return `{\n${parts.map((part) => `${inner}${part},`).join('\n')}\n${INDENT.repeat(depth)}}`;
}

export function formatPath(path: LuaKey[]): string {
    return path.map((key, index) => (index === 0 ? String(key) : isIdentifier(key) ? `.${key}` : `[${typeof key === 'number' ? key : quoteLua(key)}]`)).join('');
}
