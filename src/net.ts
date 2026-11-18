import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { InstallError } from './log.ts';

export const USER_AGENT = 'prax-installer';

export async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
    if (!response.ok) throw new InstallError(`Réponse ${response.status} de ${new URL(url).host}.`);
    return (await response.json()) as T;
}

function formatMegabytes(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

export async function downloadFile(url: string, destination: string, label: string): Promise<string> {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok || !response.body) throw new InstallError(`Téléchargement impossible (${response.status}) : ${label}.`);

    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const partial = `${destination}.part`;
    const file = fs.createWriteStream(partial);
    const hash = crypto.createHash('sha256');
    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    let lastPrint = 0;
    const showProgress = Boolean(process.stdout.isTTY);

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        received += chunk.length;
        if (!file.write(chunk)) await new Promise<void>((resolve) => file.once('drain', () => resolve()));
        const now = Date.now();
        if (showProgress && now - lastPrint > 250) {
            lastPrint = now;
            const share = total > 0 ? ` (${Math.floor((received / total) * 100)} %)` : '';
            process.stdout.write(`\r  ${label} : ${formatMegabytes(received)}${share}   `);
        }
    }
    await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())));
    if (showProgress) process.stdout.write('\r\x1b[2K');
    await fs.promises.rename(partial, destination);
    return hash.digest('hex');
}

export async function sha256File(file: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}
