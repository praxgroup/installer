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

const TEMPLATE_FILES = new Set(['server.cfg.example']);

function isSafeRelativePath(value: string): boolean {
    if (value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)) return false;
    return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function readManifest(buildDir: string): Manifest {
    const file = path.join(buildDir, 'manifest.json');
    if (!fs.existsSync(file)) {
        throw new InstallError(`Aucun manifest.json dans ${buildDir}.`, 'Indique le dossier build/<version> produit par release.bat.');
    }
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    if (manifest.format !== 1 || !Array.isArray(manifest.files)) {
        throw new InstallError(`Format de manifeste non pris en charge (${String(manifest.format)}).`, 'Mets à jour le programme prax.');
    }
    for (const entry of manifest.files) {
        if (!isSafeRelativePath(entry.path)) throw new InstallError(`Chemin refusé dans le manifeste : ${entry.path}`);
        if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new InstallError(`Empreinte invalide dans le manifeste : ${entry.path}`);
    }
    return manifest;
}

export function destinationOf(layout: Layout, relative: string): string {
    if (TEMPLATE_FILES.has(relative)) return path.join(layout.data, relative);
    return path.join(layout.resources, ...relative.split('/'));
}

export async function installFromBuild(layout: Layout, buildDir: string): Promise<Manifest> {
    const manifest = readManifest(buildDir);
    let written = 0;
    let unchanged = 0;
    let preserved = 0;

    for (const entry of manifest.files) {
        const source = path.join(buildDir, ...entry.path.split('/'));
        const destination = destinationOf(layout, entry.path);

        if (entry.preserve && fs.existsSync(destination)) {
            preserved++;
            continue;
        }
        if (fs.existsSync(destination) && (await sha256File(destination)) === entry.sha256) {
            unchanged++;
            continue;
        }
        if (!fs.existsSync(source)) throw new InstallError(`Fichier manquant dans le build : ${entry.path}`);
        const digest = await sha256File(source);
        if (digest !== entry.sha256) throw new InstallError(`Empreinte différente du manifeste : ${entry.path}`, 'Le build est abîmé : refais-le ou retélécharge-le.');

        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.copyFile(source, destination);
        written++;
    }

    log.ok(`Base ${manifest.version} : ${written} fichier(s) écrit(s), ${unchanged} déjà à jour, ${preserved} réglage(s) de l'acheteur gardé(s)`);
    return manifest;
}
