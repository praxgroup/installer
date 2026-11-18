import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findComments, langOf, lineOf } from './comments.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_FILE_BYTES = 512 * 1024;

const FORBIDDEN_NAMES = [['ny', 'kz'], ['vol', 'tre']].map((parts) => new RegExp(parts.join(''), 'i'));

const FORBIDDEN_PATHS = [
    { re: /\.lua$/i, why: 'fichier Lua : aucun code de la base dans ce dépôt' },
    { re: /(^|\/)fxmanifest\.lua$/i, why: 'manifeste de ressource FiveM' },
    { re: /(^|\/)resources\//i, why: 'dossier resources : aucun fichier de la base dans ce dépôt' },
    { re: /(^|\/)\.env(\.|$)/i, why: 'fichier .env' },
    { re: /(^|\/)\.dev\.vars$/i, why: 'fichier .dev.vars' },
    { re: /(^|\/)\.secrets\//i, why: 'dossier .secrets' },
    { re: /(^|\/)server\.cfg$/i, why: 'server.cfg' },
    { re: /\.(pem|key|p12|pfx)$/i, why: 'clé ou certificat' },
    { re: /\.(zip|7z|rar|tar|gz|xz)$/i, why: 'archive' },
    { re: /(^|\/)answers(?!\.example)[^/]*\.json$/i, why: "fichier de réponses d'une vraie installation" },
];

const SECRET_PATTERNS = [
    { re: /cfxk_[A-Za-z0-9_]{10,}/, why: 'clé de licence Cfx' },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'clé privée' },
    { re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/i, why: 'webhook Discord' },
    { re: /[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}/, why: 'token de bot Discord' },
    { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, why: 'token GitHub' },
    { re: /\b(?:api[_-]?token|secret|password|passwd)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i, why: 'secret écrit en dur' },
    { re: /\bPRAX-[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}\b/, why: 'clé de licence Prax' },
    { re: /[\w.+-]+@(?:gmail|hotmail|outlook|yahoo|live|icloud)\.[a-z]{2,}/i, why: 'adresse mail personnelle' },
];

const PUBLIC_IPV4 = /\b(?!(?:10|127|0)\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!169\.254\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function listFiles(mode) {
    if (mode === 'staged') {
        return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
    }
    const tracked = git(['ls-files', '-z']).split('\0');
    const untracked = git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0');
    return [...new Set([...tracked, ...untracked])].filter(Boolean).filter((file) => fs.existsSync(path.join(ROOT, file)));
}

function readContent(file, mode) {
    if (mode === 'staged') return execFileSync('git', ['show', `:${file}`], { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return fs.readFileSync(path.join(ROOT, file));
}

function isBinary(buffer) {
    return buffer.subarray(0, 8000).includes(0);
}

function isLocalIpv4(match) {
    const parts = match.split('.').map(Number);
    if (parts.some((part) => part > 255)) return true;
    return match === '0.0.0.0' || match === '255.255.255.255';
}

function auditFile(file, mode, errors) {
    const normalized = file.replace(/\\/g, '/');
    for (const { re, why } of FORBIDDEN_PATHS) {
        if (re.test(normalized)) errors.push(`${normalized} : ${why}`);
    }
    for (const re of FORBIDDEN_NAMES) {
        if (re.test(normalized)) errors.push(`${normalized} : nom interdit dans le chemin`);
    }

    const buffer = readContent(file, mode);
    if (buffer.length > MAX_FILE_BYTES) errors.push(`${normalized} : fichier trop gros (${Math.round(buffer.length / 1024)} Ko)`);
    if (isBinary(buffer)) return;
    const text = buffer.toString('utf8');

    for (const re of FORBIDDEN_NAMES) {
        const match = re.exec(text);
        if (match) errors.push(`${normalized}:${lineOf(text, match.index)} : nom interdit`);
    }
    for (const { re, why } of SECRET_PATTERNS) {
        const match = re.exec(text);
        if (match) errors.push(`${normalized}:${lineOf(text, match.index)} : ${why}`);
    }
    for (const match of text.matchAll(PUBLIC_IPV4)) {
        if (!isLocalIpv4(match[0])) errors.push(`${normalized}:${lineOf(text, match.index)} : adresse IP publique ${match[0]}`);
    }

    const lang = langOf(normalized);
    if (lang) {
        for (const comment of findComments(text, lang)) {
            errors.push(`${normalized}:${lineOf(text, comment.start)} : commentaire interdit (${comment.text.slice(0, 50)})`);
        }
    }
}

function main() {
    const mode = process.argv.includes('--staged') ? 'staged' : 'all';
    const files = listFiles(mode);
    const errors = [];
    for (const file of files) auditFile(file, mode, errors);

    if (errors.length > 0) {
        console.error(`Audit du dépôt public : ${errors.length} erreur(s)`);
        for (const error of errors) console.error(`  ${error}`);
        process.exit(1);
    }
    console.log(`Audit du dépôt public : 0 erreur (${files.length} fichier(s))`);
}

main();
