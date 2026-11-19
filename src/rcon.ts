import dgram from 'node:dgram';
import { InstallError } from './log.ts';

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const QUIET_MS = 400;

export function sendRcon(port: number, password: string, command: string, timeoutMs = 4_000): Promise<string> {
    if (/["\r\n;]/.test(command)) return Promise.reject(new InstallError('Commande console refusée'));
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const chunks: string[] = [];
        let quietTimer: NodeJS.Timeout | undefined;
        const finish = (error?: Error) => {
            clearTimeout(deadline);
            clearTimeout(quietTimer);
            socket.close();
            if (error) reject(error);
            else resolve(chunks.join('').trim());
        };
        const deadline = setTimeout(() => {
            if (chunks.length > 0) finish();
            else finish(new InstallError(`Le serveur ne répond pas en RCON sur le port ${port}`, 'Vérifie qu\'il est lancé et que rcon_password est bien dans server.cfg.'));
        }, timeoutMs);
        socket.on('message', (message) => {
            const text = message.subarray(4).toString('utf8').replace(/^print\s?/, '');
            if (/Invalid password/i.test(text)) {
                finish(new InstallError('Mot de passe RCON refusé', 'Le rcon_password de server.cfg a changé depuis l\'installation.'));
                return;
            }
            chunks.push(text);
            clearTimeout(quietTimer);
            quietTimer = setTimeout(() => finish(), QUIET_MS);
        });
        socket.on('error', (error) => finish(error));
        socket.send(Buffer.concat([HEADER, Buffer.from(`rcon "${password}" ${command}`, 'utf8')]), port, '127.0.0.1');
    });
}
