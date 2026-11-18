const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
    return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const log = {
    title(text: string): void {
        console.log(paint('1', text));
    },
    step(text: string): void {
        console.log(`\n${paint('1;36', '›')} ${paint('1', text)}`);
    },
    info(text: string): void {
        console.log(`  ${text}`);
    },
    ok(text: string): void {
        console.log(`  ${paint('32', '✓')} ${text}`);
    },
    skip(text: string): void {
        console.log(`  ${paint('90', '·')} ${paint('90', text)}`);
    },
    warn(text: string): void {
        console.log(`  ${paint('33', '!')} ${text}`);
    },
    fail(text: string): void {
        console.error(`  ${paint('31', '✗')} ${text}`);
    },
};

export class InstallError extends Error {
    readonly hint: string | undefined;

    constructor(message: string, hint?: string) {
        super(message);
        this.name = 'InstallError';
        this.hint = hint;
    }
}
