import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Layout } from './layout.ts';
import { InstallError, log } from './log.ts';
import { downloadFile, fetchJson } from './net.ts';
import type { Target } from './platform.ts';

const VERSIONS_URL: Record<Target, string> = {
    windows: 'https://changelogs-live.fivem.net/api/changelog/versions/win32/server',
    linux: 'https://changelogs-live.fivem.net/api/changelog/versions/linux/server',
};

const ARTIFACT_HOST = 'runtime.fivem.net';
const BUILD_MARKER = '.prax-build';

export type FxChannel = 'recommended' | 'latest';

export type FxBuild = {
    build: string;
    url: string;
    txAdminVersion: string;
};

type VersionsResponse = Record<string, unknown>;

export async function resolveBuild(target: Target, channel: FxChannel): Promise<FxBuild> {
    const versions = await fetchJson<VersionsResponse>(VERSIONS_URL[target]);
    const build = versions[channel];
    const url = versions[`${channel}_download`];
    const txAdminVersion = versions[`${channel}_txadmin`];
    if (typeof build !== 'string' || typeof url !== 'string') {
        throw new InstallError(`Cfx n'a pas renvoyé de version « ${channel} » de FXServer.`);
    }
    if (new URL(url).host !== ARTIFACT_HOST) {
        throw new InstallError(`Adresse de téléchargement de FXServer inattendue : ${new URL(url).host}.`);
    }
    return { build, url, txAdminVersion: typeof txAdminVersion === 'string' ? txAdminVersion : 'inconnue' };
}

export function installedBuild(layout: Layout): string | null {
    const marker = path.join(layout.fxserver, BUILD_MARKER);
    return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null;
}

function windowsTar(): string {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    return path.join(systemRoot, 'System32', 'tar.exe');
}

function extract(target: Target, archive: string, destination: string): void {
    fs.mkdirSync(destination, { recursive: true });
    if (target === 'windows') {
        execFileSync(windowsTar(), ['-xf', archive, '-C', destination], { stdio: 'inherit' });
    } else {
        execFileSync('tar', ['-xJf', archive, '-C', destination], { stdio: 'inherit' });
    }
}

export function fxServerExecutable(layout: Layout, target: Target): string {
    return target === 'windows' ? path.join(layout.fxserver, 'FXServer.exe') : path.join(layout.fxserver, 'run.sh');
}

export async function installFxServer(layout: Layout, target: Target, fx: FxBuild): Promise<void> {
    if (installedBuild(layout) === fx.build) {
        log.skip(`FXServer ${fx.build} déjà installé`);
        return;
    }

    const archiveName = target === 'windows' ? `fxserver-${fx.build}.zip` : `fxserver-${fx.build}.tar.xz`;
    const archive = path.join(layout.cache, archiveName);
    if (!fs.existsSync(archive)) {
        const digest = await downloadFile(fx.url, archive, `FXServer ${fx.build}`);
        log.ok(`FXServer ${fx.build} téléchargé (sha256 ${digest.slice(0, 12)}…)`);
    }

    const staging = `${layout.fxserver}.new`;
    fs.rmSync(staging, { recursive: true, force: true });
    extract(target, archive, staging);

    const executable = target === 'windows' ? path.join(staging, 'FXServer.exe') : path.join(staging, 'run.sh');
    if (!fs.existsSync(executable)) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw new InstallError("L'archive de FXServer ne contient pas l'exécutable attendu.", `Supprime ${archive} et relance l'installation.`);
    }

    fs.writeFileSync(path.join(staging, BUILD_MARKER), `${fx.build}\n`);
    const previous = `${layout.fxserver}.old`;
    fs.rmSync(previous, { recursive: true, force: true });
    if (fs.existsSync(layout.fxserver)) fs.renameSync(layout.fxserver, previous);
    fs.renameSync(staging, layout.fxserver);
    fs.rmSync(previous, { recursive: true, force: true });
    log.ok(`FXServer ${fx.build} installé (txAdmin ${fx.txAdminVersion})`);
}
