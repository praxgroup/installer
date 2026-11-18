import fs from 'node:fs';
import readline from 'node:readline/promises';
import { InstallError } from './log.ts';

export type Question = {
    key: string;
    label: string;
    defaultValue?: string;
    secret?: boolean;
    optional?: boolean;
    validate?: (value: string) => string | null;
};

export function envKeyOf(key: string): string {
    return 'PRAX_' + key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

async function readSecret(prompt: string): Promise<string> {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    return new Promise((resolve) => {
        let value = '';
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        const onData = (chunk: string) => {
            for (const char of chunk) {
                if (char === '\r' || char === '\n') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.off('data', onData);
                    process.stdout.write('\n');
                    resolve(value);
                    return;
                }
                if (char === '\u0003') process.exit(130);
                if (char === '\u007f' || char === '\b') {
                    value = value.slice(0, -1);
                    continue;
                }
                value += char;
            }
        };
        stdin.on('data', onData);
    });
}

export class Answers {
    private readonly fromFile: Record<string, string>;
    private readonly interactive: boolean;

    constructor(file: string | undefined, interactive: boolean) {
        this.fromFile = {};
        if (file) {
            const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (typeof parsed !== 'object' || parsed === null) throw new InstallError(`Fichier de réponses invalide : ${file}`);
            for (const [key, value] of Object.entries(parsed)) this.fromFile[key] = String(value);
        }
        this.interactive = interactive && Boolean(process.stdin.isTTY);
    }

    get canPrompt(): boolean {
        return this.interactive;
    }

    private check(question: Question, value: string): string {
        const problem = question.validate?.(value) ?? null;
        if (problem) throw new InstallError(`${question.label} : ${problem}`);
        return value;
    }

    async ask(question: Question): Promise<string> {
        const envKey = envKeyOf(question.key);
        const provided = this.fromFile[question.key] ?? process.env[envKey];
        if (provided !== undefined) return this.check(question, provided);

        if (!this.interactive) {
            if (question.defaultValue !== undefined) return this.check(question, question.defaultValue);
            if (question.optional) return '';
            throw new InstallError(
                `Réponse manquante : ${question.label}`,
                `Donne-la dans le fichier --answers (clé « ${question.key} ») ou dans la variable ${envKey}.`,
            );
        }

        const suffix = question.defaultValue !== undefined ? ` [${question.defaultValue}]` : question.optional ? ' (facultatif)' : '';
        const prompt = `  ${question.label}${suffix} : `;
        for (;;) {
            let value: string;
            if (question.secret) {
                value = await readSecret(prompt);
            } else {
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                value = await rl.question(prompt);
                rl.close();
            }
            value = value.trim();
            if (value === '' && question.defaultValue !== undefined) value = question.defaultValue;
            if (value === '' && !question.optional) continue;
            const problem = question.validate?.(value) ?? null;
            if (!problem) return value;
            console.log(`    ${problem}`);
        }
    }

    async confirm(label: string, defaultYes: boolean, key: string = label): Promise<boolean> {
        const value = await this.ask({
            key,
            label: `${label} (o/n)`,
            defaultValue: defaultYes ? 'o' : 'n',
            validate: (answer) => (/^(o|oui|y|yes|n|non|no)$/i.test(answer) ? null : 'réponds o ou n'),
        });
        return /^(o|oui|y|yes)$/i.test(value);
    }
}
