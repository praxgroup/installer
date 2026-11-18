import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import { InstallError } from './log.ts';

export type Target = 'windows' | 'linux';
export type Container = 'pterodactyl' | 'docker' | null;

export type Host = {
    target: Target;
    container: Container;
    gamePort: number;
};

export const DEFAULT_GAME_PORT = 30120;
export const DEFAULT_TXADMIN_PORT = 40120;

export function detectHost(): Host {
    let target: Target;
    if (process.platform === 'win32') target = 'windows';
    else if (process.platform === 'linux') target = 'linux';
    else if (process.platform === 'darwin') {
        throw new InstallError(
            "Cfx ne publie pas FXServer pour macOS : la base ne peut pas tourner directement sur un Mac.",
            "Sur Mac, installe la base avec l'image Docker (voir la documentation, « Installer sur Mac »).",
        );
    } else {
        throw new InstallError(`Système non pris en charge : ${process.platform}.`);
    }

    if (process.arch !== 'x64') {
        throw new InstallError(
            `Processeur non pris en charge : ${process.arch}. FXServer n'existe que pour x64.`,
            'Utilise une machine x64 (Intel ou AMD).',
        );
    }

    let container: Container = null;
    if (process.env.P_SERVER_UUID) container = 'pterodactyl';
    else if (fs.existsSync('/.dockerenv')) container = 'docker';

    const portFromHost = Number(process.env.SERVER_PORT);
    const gamePort = Number.isInteger(portFromHost) && portFromHost > 0 ? portFromHost : DEFAULT_GAME_PORT;

    return { target, container, gamePort };
}

export async function freeDiskBytes(dir: string): Promise<number> {
    const stats = await fs.promises.statfs(dir);
    return stats.bavail * stats.bsize;
}

function isTcpFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => server.close(() => resolve(true)));
        server.listen(port, '0.0.0.0');
    });
}

function isUdpFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', () => resolve(false));
        socket.once('listening', () => socket.close(() => resolve(true)));
        socket.bind(port, '0.0.0.0');
    });
}

export async function isPortFree(port: number, udp: boolean): Promise<boolean> {
    if (!(await isTcpFree(port))) return false;
    return udp ? isUdpFree(port) : true;
}

export function isAsciiPath(value: string): boolean {
    return /^[\x00-\x7f]*$/.test(value);
}
