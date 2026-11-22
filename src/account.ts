import crypto from 'node:crypto';
import type { Layout } from './layout.ts';
import { parseLicense } from './license.ts';
import type { InstallLicense } from './license.ts';
import { InstallError, log } from './log.ts';
import { applyManifest, checkManifest } from './manifest.ts';
import type { Manifest } from './manifest.ts';
import { USER_AGENT } from './net.ts';

export const DEFAULT_SITE = 'https://prax-studio.fr';

const REMOTE_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const BLOB_TIMEOUT_MS = 300_000;
const RETRIES = 3;
const INSTALL_TOKEN = /^pxi_[0-9a-f]{48}$/;

export type SiteSession = {
    site: string;
    license: InstallLicense;
    downloadToken: string;
    expiresAt: number;
};

type Delivery = { install: unknown; download: { token: string; expiresAt: number } };
type DeviceStart = { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number; interval: number };
type PollResult = { status: 'pending' | 'denied' | 'expired' | 'used'; interval?: number } | Delivery;

export function resolveSite(value: string | undefined): string {
    const raw = (value || process.env.PRAX_SITE_URL || DEFAULT_SITE).replace(/\/+$/, '');
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new InstallError(`Adresse du site invalide : ${raw}`);
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new InstallError(`Le site doit être en https : ${raw}`);
    return url.origin;
}

async function request<T>(site: string, method: string, route: string, options: { body?: unknown; token?: string; timeoutMs?: number } = {}): Promise<T> {
    let response: Response;
    try {
        response = await fetch(`${site}/api/${route}`, {
            method,
            headers: {
                'user-agent': USER_AGENT,
                'x-requested-with': 'prax',
                accept: 'application/json',
                ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        throw new InstallError(`Le site ${new URL(site).host} ne répond pas (${(error as Error).message}).`, 'Vérifie ta connexion, puis relance prax install.');
    }
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new InstallError(data.error ?? `Réponse ${response.status} du site.`);
    return data;
}

function sessionOf(site: string, delivery: Delivery): SiteSession {
    const license = parseLicense(delivery.install);
    if (!delivery.download?.token) throw new InstallError('Le site n\'a pas donné d\'accès au téléchargement.');
    return { site, license, downloadToken: delivery.download.token, expiresAt: delivery.download.expiresAt };
}

export async function connectWithToken(site: string, token: string): Promise<SiteSession> {
    const value = token.trim();
    if (!INSTALL_TOKEN.test(value)) throw new InstallError('Jeton d\'installation invalide.', 'Il commence par pxi_ : copie-le depuis ton espace client, page Installer.');
    log.step('Compte client');
    const session = sessionOf(site, await request<Delivery>(site, 'POST', 'install/redeem', { body: { token: value } }));
    log.ok(`Licence reçue : ${session.license.label}`);
    return session;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectWithCode(site: string): Promise<SiteSession> {
    log.step('Compte client');
    const device = await request<DeviceStart>(site, 'POST', 'install/device', { body: {} });
    log.info('Ouvre cette adresse dans ton navigateur, connecte-toi et choisis ta licence :');
    log.info(`    ${device.verificationUriComplete}`);
    log.info(`Ou va sur ${device.verificationUri} et tape le code : ${device.userCode}`);
    log.info('Ne donne jamais ce code à quelqu\'un d\'autre : il donne accès à ta licence.');
    const deadline = Date.now() + device.expiresIn * 1000;
    let interval = Math.max(2, device.interval) * 1000;
    while (Date.now() < deadline) {
        await sleep(interval);
        const result = await request<PollResult>(site, 'POST', 'install/poll', { body: { deviceCode: device.deviceCode } });
        if ('install' in result) {
            const session = sessionOf(site, result);
            log.ok(`Licence reçue : ${session.license.label}`);
            return session;
        }
        if (result.status === 'denied') throw new InstallError('Demande refusée depuis l\'espace client.');
        if (result.status === 'expired') break;
        if (result.status === 'used') throw new InstallError('Ce code a déjà servi.', 'Relance prax install pour en obtenir un nouveau.');
        if (result.interval) interval = Math.max(2, result.interval) * 1000;
    }
    throw new InstallError('Le code a expiré avant d\'être autorisé.', 'Relance prax install pour en obtenir un nouveau.');
}

type LicenseDelivery = { download: { token: string; expiresAt: number }; license: { key: string; label: string } };

export async function connectWithLicense(site: string, key: string, secret: string): Promise<SiteSession> {
    log.step('Compte client');
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString('hex');
    const signature = crypto.createHmac('sha256', secret).update(['prax-update', key, timestamp, nonce].join('|')).digest('hex');
    const delivery = await request<LicenseDelivery>(site, 'POST', 'install/license', { body: { license: key, timestamp, nonce, signature } });
    if (!delivery.download?.token) throw new InstallError('Le site n\'a pas donné d\'accès au téléchargement.');
    const license = parseLicense({ format: 1, license: { key, secret, plan: 'standard', label: delivery.license?.label ?? key } });
    log.ok(`Licence du serveur reconnue : ${license.label}`);
    return { site, license, downloadToken: delivery.download.token, expiresAt: delivery.download.expiresAt };
}

export const BASE_CHANNELS = ['release', 'early', 'beta', 'dev'] as const;
export type BaseChannel = (typeof BASE_CHANNELS)[number];
export const DEFAULT_BASE_CHANNEL: BaseChannel = 'release';

export function isBaseChannel(value: unknown): value is BaseChannel {
    return typeof value === 'string' && (BASE_CHANNELS as readonly string[]).includes(value);
}

type ReleaseList = { channel?: string; channels?: string[]; latest: string | null; versions: { version: string; channel?: string }[] };

export async function fetchRelease(session: SiteSession, version: string | undefined, channel: BaseChannel = DEFAULT_BASE_CHANNEL): Promise<Manifest> {
    const index = await request<ReleaseList>(session.site, 'GET', `install/releases?channel=${channel}`, { token: session.downloadToken });
    const wanted = version ?? index.latest;
    if (!wanted) {
        throw new InstallError(`Aucune version de la base n'est encore publiée sur le canal ${channel}.`, 'Réessaie plus tard, choisis un autre canal (--channel), ou installe depuis un build local avec --from.');
    }
    if (version && !index.versions.some((entry) => entry.version === version)) {
        const available = index.versions.map((entry) => (entry.channel ? `${entry.version} (${entry.channel})` : entry.version)).join(', ');
        throw new InstallError(`Version ${version} introuvable, retirée ou réservée à un autre canal.`, `Versions disponibles pour cette licence : ${available || 'aucune'}.`);
    }
    const entry = index.versions.find((item) => item.version === wanted);
    log.info(`Canal ${channel} : version ${wanted}${entry?.channel && entry.channel !== channel ? ` (publiée sur ${entry.channel})` : ''}.`);
    const manifest = checkManifest(await request<unknown>(session.site, 'GET', `install/releases/${wanted}`, { token: session.downloadToken }), `version ${wanted}`);
    if (manifest.version !== wanted) throw new InstallError(`Le site a renvoyé la version ${manifest.version} au lieu de ${wanted}.`);
    return manifest;
}

async function downloadBlob(session: SiteSession, hash: string): Promise<Buffer> {
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await fetch(`${session.site}/api/install/blobs/${hash}`, {
                headers: { 'user-agent': USER_AGENT, authorization: `Bearer ${session.downloadToken}` },
                signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
            });
            if (response.status === 401) throw new InstallError('L\'accès au téléchargement a expiré.', 'Relance prax install : les fichiers déjà reçus sont gardés.');
            if (!response.ok) throw new Error(`réponse ${response.status}`);
            return Buffer.from(await response.arrayBuffer());
        } catch (error) {
            if (error instanceof InstallError || attempt >= RETRIES) {
                if (error instanceof InstallError) throw error;
                throw new InstallError(`Téléchargement impossible (${(error as Error).message}).`, 'Relance prax install : les fichiers déjà reçus sont gardés.');
            }
            await sleep(attempt * 2000);
        }
    }
}

export async function installFromSite(layout: Layout, session: SiteSession, version: string | undefined, channel: BaseChannel = DEFAULT_BASE_CHANNEL): Promise<Manifest> {
    return applySiteManifest(layout, session, await fetchRelease(session, version, channel));
}

export async function applySiteManifest(layout: Layout, session: SiteSession, manifest: Manifest): Promise<Manifest> {
    log.info(`Version ${manifest.version} : ${manifest.files.length} fichiers, vérifiés un par un.`);
    const packs = manifest.packs?.length ?? 0;
    if (packs > 0) log.info(`Petits fichiers regroupés en ${packs} paquets.`);
    await applyManifest(layout, manifest, (entry) => downloadBlob(session, entry.sha256), REMOTE_CONCURRENCY, (hash) => downloadBlob(session, hash));
    return manifest;
}
