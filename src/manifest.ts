import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Layout } from './layout.ts';
import { InstallError, log } from './log.ts';
import { sha256File } from './net.ts';

export type ManifestFile = {
    path: string;
    size: number;
    sha256: string;
    preserve: boolean;
};

export type Manifest = {
    format: 1;
    version: string;
    commit: string;
    createdAt: string;
    files: ManifestFile[];
};

export type FileFetcher = (entry: ManifestFile) => Promise<Buffer>;

const LOCAL_CONCURRENCY = 4;
const PROGRESS_EVERY_MS = 250;

function isSafeRelativePath(value: string): boolean {
    if (value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)) return false;
    return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function checkManifest(raw: unknown, origin: string): Manifest {
    const manifest = raw as Manifest;
    if (manifest?.format !== 1 || !Array.isArray(manifest.files)) {
        throw new InstallError(`Format de manifeste non pris en charge (${String(manifest?.format)}) : ${origin}.`, 'Mets à jour le programme prax.');
    }
    for (const entry of manifest.files) {
        if (typeof entry.path !== 'string' || !isSafeRelativePath(entry.path)) throw new InstallError(`Chemin refusé dans le manifeste : ${String(entry.path)}`);
        if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new InstallError(`Empreinte invalide dans le manifeste : ${entry.path}`);
    }
    return manifest;
}

export function readManifest(buildDir: string): Manifest {
    const file = path.join(buildDir, 'manifest.json');
    if (!fs.existsSync(file)) {
        throw new InstallError(`Aucun manifest.json dans ${buildDir}.`, 'Indique le dossier build/<version> produit par release.bat.');
    }
    return checkManifest(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

export function destinationOf(layout: Layout, relative: string): string {
    if (!relative.includes('/')) return path.join(layout.data, relative);
    return path.join(layout.resources, ...relative.split('/'));
}

function formatMegabytes(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

export async function applyManifest(layout: Layout, manifest: Manifest, fetchFile: FileFetcher, concurrency: number): Promise<void> {
    const needed: ManifestFile[] = [];
    let unchanged = 0;
    let preserved = 0;
    for (const entry of manifest.files) {
        const destination = destinationOf(layout, entry.path);
        if (entry.preserve && fs.existsSync(destination)) {
            preserved++;
            continue;
        }
        if (fs.existsSync(destination) && (await sha256File(destination)) === entry.sha256) {
            unchanged++;
            continue;
        }
        needed.push(entry);
    }

    const total = needed.reduce((sum, entry) => sum + entry.size, 0);
    const showProgress = Boolean(process.stdout.isTTY) && total > 0;
    let done = 0;
    let doneBytes = 0;
    let lastPrint = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < needed.length) {
            const entry = needed[next++] as ManifestFile;
            const data = await fetchFile(entry);
            const digest = crypto.createHash('sha256').update(data).digest('hex');
            if (digest !== entry.sha256) throw new InstallError(`Empreinte différente du manifeste : ${entry.path}`, 'Le fichier reçu est abîmé ou modifié : relance l\'installation.');
            const destination = destinationOf(layout, entry.path);
            await fs.promises.mkdir(path.dirname(destination), { recursive: true });
            const partial = `${destination}.part`;
            await fs.promises.writeFile(partial, data);
            await fs.promises.rename(partial, destination);
            done++;
            doneBytes += entry.size;
            const now = Date.now();
            if (showProgress && now - lastPrint > PROGRESS_EVERY_MS) {
                lastPrint = now;
                process.stdout.write(`\r  ${done}/${needed.length} fichiers · ${formatMegabytes(doneBytes)} sur ${formatMegabytes(total)}   `);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    if (showProgress) process.stdout.write('\r\x1b[2K');

    log.ok(`Base ${manifest.version} : ${done} fichier(s) écrit(s), ${unchanged} déjà à jour, ${preserved} réglage(s) de l'acheteur gardé(s)`);
}

export async function installFromBuild(layout: Layout, buildDir: string): Promise<Manifest> {
    const manifest = readManifest(buildDir);
    await applyManifest(layout, manifest, async (entry) => {
        const source = path.join(buildDir, ...entry.path.split('/'));
        if (!fs.existsSync(source)) throw new InstallError(`Fichier manquant dans le build : ${entry.path}`);
        return fs.promises.readFile(source);
    }, LOCAL_CONCURRENCY);
    return manifest;
}
