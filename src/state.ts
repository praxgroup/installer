import fs from 'node:fs';
import path from 'node:path';

type StepRecord = { doneAt: string; details?: Record<string, string> };
type StateFile = { format: 1; steps: Record<string, StepRecord> };

export class InstallState {
    private readonly file: string;
    private data: StateFile;

    constructor(file: string) {
        this.file = file;
        this.data = { format: 1, steps: {} };
        if (fs.existsSync(file)) {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StateFile;
            if (parsed.format === 1) this.data = parsed;
        }
    }

    isDone(step: string): boolean {
        return step in this.data.steps;
    }

    details(step: string): Record<string, string> {
        return this.data.steps[step]?.details ?? {};
    }

    markDone(step: string, details?: Record<string, string>): void {
        this.data.steps[step] = { doneAt: new Date().toISOString(), details };
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n');
    }

    reset(step: string): void {
        delete this.data.steps[step];
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n');
    }
}

export function writePrivateJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export function readPrivateJson<T>(file: string): T | null {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
