import path from 'node:path';

const LANG_BY_EXT = {
    '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.mts': 'js',
    '.sh': 'hash', '.ps1': 'hash', '.yml': 'hash', '.yaml': 'hash', '.toml': 'hash', '.cfg': 'hash',
    '.bat': 'bat', '.cmd': 'bat',
};

const KEEP_JS = [/^\/\/\s*@ts-/, /^\/\/\/\s*<reference/, /eslint-/];

export function langOf(file) {
    const base = path.basename(file);
    if (base === 'Dockerfile' || base.endsWith('.Dockerfile')) return 'hash';
    return LANG_BY_EXT[path.extname(file).toLowerCase()] || null;
}

function skipQuoted(text, i, quote) {
    i++;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote || c === '\n') return i + 1;
        i++;
    }
    return i;
}

const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

function skipRegex(text, i) {
    i++;
    let inClass = false;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') return i;
        if (inClass) { if (c === ']') inClass = false; }
        else if (c === '[') inClass = true;
        else if (c === '/') { i++; while (/[a-z]/i.test(text[i] || '')) i++; return i; }
        i++;
    }
    return i;
}

function scanJs(text) {
    const found = [];
    let prev = '';

    function code(i, stopOnBrace) {
        let depth = 0;
        while (i < text.length) {
            const c = text[i];
            const n = text[i + 1];
            if (c === '/' && n === '*') {
                const end = text.indexOf('*/', i + 2);
                const stop = end === -1 ? text.length : end + 2;
                found.push({ start: i, end: stop });
                i = stop;
                continue;
            }
            if (c === '/' && n === '/') {
                const nl = text.indexOf('\n', i);
                const stop = nl === -1 ? text.length : nl;
                found.push({ start: i, end: stop });
                i = stop;
                continue;
            }
            if (c === '"' || c === "'") { i = skipQuoted(text, i, c); prev = 'x'; continue; }
            if (c === '`') { i = template(i + 1); prev = 'x'; continue; }
            if (c === '/' && REGEX_PREV.has(prev)) { i = skipRegex(text, i); prev = 'x'; continue; }
            if (stopOnBrace) {
                if (c === '{') depth++;
                else if (c === '}') { if (depth === 0) return i + 1; depth--; }
            }
            if (!/\s/.test(c)) prev = /[\w$)\].]/.test(c) ? 'x' : c;
            i++;
        }
        return i;
    }

    function template(i) {
        while (i < text.length) {
            const c = text[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '`') return i + 1;
            if (c === '$' && text[i + 1] === '{') { prev = '{'; i = code(i + 2, true); continue; }
            i++;
        }
        return i;
    }

    code(0, false);
    return found
        .map((c) => ({ ...c, text: text.slice(c.start, c.end) }))
        .filter((c) => !KEEP_JS.some((re) => re.test(c.text)));
}

function scanLines(text, isComment) {
    const found = [];
    let offset = 0;
    const lines = text.split('\n');
    lines.forEach((line, index) => {
        if (isComment(line.trim(), index)) found.push({ start: offset, end: offset + line.length, text: line.trim() });
        offset += line.length + 1;
    });
    return found;
}

export function findComments(text, lang) {
    if (lang === 'js') return scanJs(text);
    if (lang === 'hash') return scanLines(text, (line, index) => line.startsWith('#') && !(index === 0 && line.startsWith('#!')) && !line.startsWith('#Requires'));
    if (lang === 'bat') return scanLines(text, (line) => /^(rem\b|::)/i.test(line));
    return [];
}

export function lineOf(text, offset) {
    return text.slice(0, offset).split('\n').length;
}
