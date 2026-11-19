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

export type ManifestPack = {
    sha256: string;
    size: number;
    files: { path: string; offset: number }[];
};

export type Manifest = {
    format: 1;
    version: string;
    commit: string;
    createdAt: string;
    files: ManifestFile[];
    packs?: ManifestPack[];
};

export type FileFetcher = (entry: ManifestFile) => Promise<Buffer>;
export type BlobFetcher = (sha256: string) => Promise<Buffer>;

const SHA256 = /^[0-9a-f]{64}$/;

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
        if (!SHA256.test(entry.sha256)) throw new InstallError(`Empreinte invalide dans le manifeste : ${entry.path}`);
    }
    if (manifest.packs !== undefined) {
        if (!Array.isArray(manifest.packs)) throw new InstallError(`Paquets invalides dans le manifeste : ${origin}.`);
        const sizes = new Map(manifest.files.map((entry) => [entry.path, entry.size]));
        for (const pack of manifest.packs) {
            if (!SHA256.test(pack.sha256) || !Number.isInteger(pack.size) || !Array.isArray(pack.files)) throw new InstallError(`Paquet invalide dans le manifeste : ${origin}.`);
            for (const member of pack.files) {
                const size = sizes.get(member.path);
                if (size === undefined || !Number.isInteger(member.offset) || member.offset < 0 || member.offset + size > pack.size) {
                    throw new InstallError(`Paquet incohérent dans le manifeste : ${String(member.path)}`);
                }
            }
        }
    }
    return manifest;
}

function verify(data: Buffer, sha256: string, label: string): void {
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    if (digest !== sha256) throw new InstallError(`Empreinte différente du manifeste : ${label}`, 'Le fichier reçu est abîmé ou modifié : relance l\'installation.');
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

export async function applyManifest(layout: Layout, manifest: Manifest, fetchFile: FileFetcher, concurrency: number, fetchBlob?: BlobFetcher): Promise<void> {
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
    const write = async (entry: ManifestFile, data: Buffer): Promise<void> => {
        verify(data, entry.sha256, entry.path);
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
    };

    type Unit = { kind: 'file'; entry: ManifestFile } | { kind: 'pack'; pack: ManifestPack; members: { entry: ManifestFile; offset: number }[] };
    const units: Unit[] = [];
    const neededByPath = new Map(needed.map((entry) => [entry.path, entry]));
    if (fetchBlob && manifest.packs) {
        for (const pack of manifest.packs) {
            const members = pack.files.flatMap((member) => {
                const entry = neededByPath.get(member.path);
                return entry ? [{ entry, offset: member.offset }] : [];
            });
            if (members.length === 0) continue;
            for (const member of members) neededByPath.delete(member.entry.path);
            units.push({ kind: 'pack', pack, members });
        }
    }
    for (const entry of neededByPath.values()) units.push({ kind: 'file', entry });
    units.sort((a, b) => (b.kind === 'pack' ? b.pack.size : b.entry.size) - (a.kind === 'pack' ? a.pack.size : a.entry.size));

    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < units.length) {
            const unit = units[next++] as Unit;
            if (unit.kind === 'file') {
                await write(unit.entry, await fetchFile(unit.entry));
                continue;
            }
            const data = await (fetchBlob as BlobFetcher)(unit.pack.sha256);
            verify(data, unit.pack.sha256, `paquet ${unit.pack.sha256.slice(0, 12)}`);
            for (const member of unit.members) await write(member.entry, data.subarray(member.offset, member.offset + member.entry.size));
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
