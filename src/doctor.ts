import fs from 'node:fs';
import { installedBuild } from './fxserver.ts';
import { fxServerExecutable } from './fxserver.ts';
import { layoutOf } from './layout.ts';
import { log } from './log.ts';
import { detectHost } from './platform.ts';
import { DEV_ONLY_CONVARS, hasDirective, readCfgValue } from './servercfg.ts';

type Finding = { ok: boolean; text: string; fix?: string };

const PLACEHOLDERS = ['CHANGE_ME', 'remplacer_par_votre_license'];
const REQUIRED_RESOURCES = ['pdeps', 'pstreams', 'pconfig', 'pcore', 'pguard'];
const ENSURED_RESOURCES = ['pdeps', 'pstreams', 'pcore', 'pguard'];

export function runDoctor(dir: string): number {
    const layout = layoutOf(dir);
    const host = detectHost();
    const findings: Finding[] = [];

    const build = installedBuild(layout);
    findings.push(build && fs.existsSync(fxServerExecutable(layout, host.target))
        ? { ok: true, text: `FXServer ${build} installé` }
        : { ok: false, text: 'FXServer absent', fix: 'Relance prax install.' });

    for (const resource of REQUIRED_RESOURCES) {
        const present = fs.existsSync(`${layout.resources}/${resource}/fxmanifest.lua`);
        findings.push(present
            ? { ok: true, text: `Ressource ${resource} présente` }
            : { ok: false, text: `Ressource ${resource} absente`, fix: 'Relance prax install pour remettre les fichiers de la base.' });
    }

    if (!fs.existsSync(layout.serverCfg)) {
        findings.push({ ok: false, text: 'server.cfg absent', fix: 'Relance prax install --reconfigure.' });
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

    log.title(`Diagnostic de ${layout.root}`);
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
