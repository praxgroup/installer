import path from 'node:path';

export type Layout = {
    root: string;
    fxserver: string;
    data: string;
    resources: string;
    serverCfg: string;
    serverCfgTemplate: string;
    txData: string;
    praxDir: string;
    cache: string;
    state: string;
    localSecrets: string;
    mariadb: string;
    mariadbData: string;
    serverLog: string;
};

export function layoutOf(root: string): Layout {
    const absolute = path.resolve(root);
    const data = path.join(absolute, 'data');
    const praxDir = path.join(absolute, '.prax');
    return {
        root: absolute,
        fxserver: path.join(absolute, 'server'),
        data,
        resources: path.join(data, 'resources'),
        serverCfg: path.join(data, 'server.cfg'),
        serverCfgTemplate: path.join(data, 'server.cfg.example'),
        txData: path.join(absolute, 'txData'),
        praxDir,
        cache: path.join(praxDir, 'cache'),
        state: path.join(praxDir, 'state.json'),
        localSecrets: path.join(praxDir, 'local-secrets.json'),
        mariadb: path.join(absolute, 'mariadb'),
        mariadbData: path.join(absolute, 'mariadb', 'data'),
        serverLog: path.join(praxDir, 'server.log'),
    };
}
