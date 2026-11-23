import fs from 'node:fs';
import { configFindings } from './configcli.ts';
import { installedBuild } from './fxserver.ts';
import { fxServerExecutable } from './fxserver.ts';
import { layoutOf } from './layout.ts';
import { log } from './log.ts';
import { detectHost } from './platform.ts';
import { DEV_ONLY_CONVARS, hasDirective, readCfgValue } from './servercfg.ts';
import { missingResources, probeServer } from './system.ts';

export type Finding = { ok: boolean; text: string; fix?: string; blocking?: boolean };

const PLACEHOLDERS = ['CHANGE_ME', 'remplacer_par_votre_license'];
const REQUIRED_RESOURCES = ['pdeps', 'pstreams', 'pconfig', 'pcore', 'pguard'];
const ENSURED_RESOURCES = ['pdeps', 'pstreams', 'pcore', 'pguard'];
const MEGABYTE = 1024 * 1024;

export async function runDoctor(dir: string): Promise<number> {
    const { root, findings } = await collectFindings(dir);
    log.title(`Diagnostic de ${root}`);
    let problems = 0;
    for (const finding of findings) {
        if (finding.ok) {
            log.ok(finding.text);
            continue;
        }
        problems++;
        log.fail(finding.text);
        if (finding.fix) log.info(`  → ${finding.fix}`);
    }
    log.step(problems === 0 ? 'Aucun problème trouvé' : `${problems} problème(s) trouvé(s)`);
    return problems === 0 ? 0 : 1;
}

export async function collectFindings(dir: string): Promise<{ root: string; findings: Finding[] }> {
    const layout = layoutOf(dir);
    const host = detectHost();
    const findings: Finding[] = [];

    const build = installedBuild(layout);
    findings.push(build && fs.existsSync(fxServerExecutable(layout, host.target))
        ? { ok: true, text: `FXServer ${build} installé` }
        : { ok: false, text: 'FXServer absent', fix: 'Relance prax install.', blocking: true });

    for (const resource of REQUIRED_RESOURCES) {
        const present = fs.existsSync(`${layout.resources}/${resource}/fxmanifest.lua`);
        findings.push(present
            ? { ok: true, text: `Ressource ${resource} présente` }
            : { ok: false, text: `Ressource ${resource} absente`, fix: 'Relance prax install pour remettre les fichiers de la base.' });
    }

    if (fs.existsSync(`${layout.resources}/pcore/schema/index.json`)) findings.push(...configFindings(layout.resources));

    if (!fs.existsSync(layout.serverCfg)) {
        findings.push({ ok: false, text: 'server.cfg absent', fix: 'Relance prax install --reconfigure.', blocking: true });
    } else {
        const cfg = fs.readFileSync(layout.serverCfg, 'utf8');
        for (const placeholder of PLACEHOLDERS) {
            if (cfg.includes(placeholder)) findings.push({ ok: false, text: `server.cfg contient encore « ${placeholder} »`, fix: 'Remplace la valeur, ou relance prax install --reconfigure.' });
        }
        for (const convar of DEV_ONLY_CONVARS) {
            const present = ['set', 'setr', 'sets'].some((command) => hasDirective(cfg, `${command} ${convar}`));
            if (present) findings.push({ ok: false, text: `server.cfg contient ${convar}, réservé au développement de la base`, fix: 'Retire cette ligne : elle ouvre des outils de test aux joueurs.' });
        }
        const salt = readCfgValue(cfg, 'set px:guard_salt');
        findings.push(salt && salt.length >= 16
            ? { ok: true, text: 'Sel du guard renseigné' }
            : { ok: false, text: 'px:guard_salt absent ou trop court', fix: 'Ajoute set px:guard_salt "<texte aléatoire de 32 caractères>" et ne le change plus ensuite.' });
        const key = readCfgValue(cfg, 'sv_licensekey');
        findings.push(key?.startsWith('cfxk_')
            ? { ok: true, text: 'Clé de licence Cfx renseignée' }
            : { ok: false, text: 'Clé de licence Cfx manquante', fix: 'Crée-la sur portal.cfx.re et mets-la dans sv_licensekey.' });

        const ensures = cfg.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('ensure ')).map((line) => line.split(/\s+/)[1] ?? '');
        const order = ENSURED_RESOURCES.map((resource) => ensures.indexOf(resource));
        const missing = ENSURED_RESOURCES.filter((_, index) => order[index] === -1);
        const pconfigAt = ensures.indexOf('pconfig');
        if (missing.length > 0) {
            findings.push({ ok: false, text: `server.cfg ne lance pas : ${missing.join(', ')}`, fix: 'Ajoute les lignes ensure dans l\'ordre pdeps, pstreams, pcore, pguard.' });
        } else if (order.some((position, index) => index > 0 && position < (order[index - 1] ?? -1))) {
            findings.push({ ok: false, text: 'Ordre des ressources incorrect dans server.cfg', fix: 'Ordre attendu : pdeps, pstreams, pcore, pguard.' });
        } else if (pconfigAt !== -1 && pconfigAt > ensures.indexOf('pcore')) {
            findings.push({ ok: false, text: 'pconfig est lancé après pcore', fix: 'Mets ensure pconfig avant ensure pcore, ou retire la ligne : pcore le démarre de lui-même.' });
        } else {
            findings.push({ ok: true, text: 'Ordre des ressources correct' });
        }
    }

    const cfgText = fs.existsSync(layout.serverCfg) ? fs.readFileSync(layout.serverCfg, 'utf8') : '';
    const gamePort = Number(readCfgValue(cfgText, 'endpoint_add_tcp')?.split(':').pop()) || host.gamePort;
    const info = await probeServer(gamePort);
    if (!info) {
        findings.push({ ok: true, text: `Serveur à l'arrêt (aucune réponse sur le port ${gamePort})` });
    } else {
        const missing = missingResources(info);
        findings.push(missing.length === 0
            ? { ok: true, text: `Serveur en ligne sur le port ${gamePort} : pcore et pguard démarrés` }
            : { ok: false, text: `Serveur en ligne, mais ${missing.join(' et ')} n'a pas démarré`, fix: 'Regarde la console du serveur : la première erreur rouge donne la cause.' });
    }

    return { root: layout.root, findings };
}

export function diskFinding(dir: string, neededBytes: number): Finding | null {
    let free: number;
    try {
        const stats = fs.statfsSync(dir);
        free = Number(stats.bavail) * Number(stats.bsize);
    } catch {
        return null;
    }
    if (!Number.isFinite(free) || free <= 0) return null;
    const freeText = `${Math.floor(free / MEGABYTE)} Mo libres`;
    return free >= neededBytes
        ? { ok: true, text: `Espace disque suffisant (${freeText})` }
        : { ok: false, text: `Espace disque insuffisant : ${freeText}, il en faut environ ${Math.ceil(neededBytes / MEGABYTE)}`, fix: 'Libère de la place (anciennes sauvegardes dans .prax/backups, logs de txData), puis relance.', blocking: true };
}
