import { checkConfig, describeType, getEntry, listTopLevel, loadWorkspace, resolveResources, setEntry, unsetEntry } from './config.ts';
import type { ChangeResult } from './config.ts';
import { InstallError, log } from './log.ts';
import { formatLua, LuaTable } from './luaconfig.ts';
import type { LuaValue } from './luaconfig.ts';

export const CONFIG_USAGE = `Réglages de la base (écrits dans pconfig, jamais dans pcore) :
  prax config get [chemin]          valeur, défaut, type et aide d'un réglage (sans chemin : liste des réglages)
  prax config set <chemin> <valeur> modifie un réglage après l'avoir vérifié avec le schéma
  prax config unset <chemin>        remet un réglage à sa valeur par défaut
  prax config check                 vérifie tous les réglages de pconfig
  Options : --dir <dossier> (installation), ou --resources <dossier> (dossier qui contient pcore et pconfig)
  Exemples : prax config set Garage.transferFee 750
             prax config get 'Garage.garages["Pillbox Hill"]'`;

const RESTART_HINT = 'Appliqué au prochain démarrage de pcore : restart pcore dans la console ou txAdmin.';

function printValue(label: string, value: LuaValue | undefined): void {
    if (value === undefined) {
        log.info(`${label} : absent`);
        return;
    }
    const text = formatLua(value, 0);
    if (!text.includes('\n')) {
        log.info(`${label} : ${text}`);
        return;
    }
    log.info(`${label} :`);
    for (const line of text.split('\n')) log.info(`    ${line}`);
}

function printChange(change: ChangeResult): void {
    log.ok(`${change.path} modifié dans ${change.removedFile ? `${change.file} (fichier retiré : plus aucun réglage dedans)` : change.file}`);
    const before = change.before === undefined ? 'absent' : formatLua(change.before, 0);
    const after = change.after === undefined ? 'absent' : formatLua(change.after, 0);
    if (!before.includes('\n') && !after.includes('\n')) {
        log.info(`${before} → ${after}`);
    } else {
        printValue('avant', change.before);
        printValue('après', change.after);
    }
    if (change.backup) log.warn(`Ce fichier contenait des commentaires, qui ne sont pas gardés. Copie de l'ancien fichier : ${change.backup}`);
    log.info(RESTART_HINT);
}

export function runConfig(args: string[], dir: string, resources: string | undefined): number {
    const [action, target, ...rest] = args;
    const workspace = () => loadWorkspace(resolveResources(dir, resources));

    if (action === 'get') {
        const loaded = workspace();
        if (!target) {
            log.title('Réglages de la base (* : modifié dans pconfig)');
            for (const entry of listTopLevel(loaded)) log.info(`${entry.changed ? '*' : ' '} Config.${entry.key.padEnd(22)} ${entry.file}`);
            return 0;
        }
        const entry = getEntry(loaded, target);
        log.title(entry.path);
        printValue('valeur', entry.value);
        log.info(`source : ${entry.source === 'pconfig' ? entry.file : 'valeur par défaut de la base'}`);
        if (entry.source === 'pconfig') printValue('défaut', entry.defaultValue);
        if (entry.node) {
            log.info(`type : ${describeType(entry.node)}`);
            if (entry.node.label?.fr) log.info(`libellé : ${entry.node.label.fr}`);
            if (entry.node.help?.fr) log.info(`aide : ${entry.node.help.fr}`);
            if (typeof entry.node.min === 'number' || typeof entry.node.max === 'number') log.info(`bornes : ${entry.node.min ?? '-∞'} à ${entry.node.max ?? '+∞'}`);
            if (entry.node.convar) log.info(`convar : ${entry.node.convar} (réglée dans server.cfg)`);
        }
        if (entry.value instanceof LuaTable && !entry.value.isEmpty && !entry.value.isSequence) {
            log.info(`clés : ${entry.value.entries.map((item) => String(item.key)).join(', ')}`);
        }
        log.info(`fichier de réglages : ${entry.file}`);
        return 0;
    }

    if (action === 'set') {
        if (!target || rest.length === 0) throw new InstallError('Il faut un chemin et une valeur', 'Exemple : prax config set Garage.transferFee 750');
        printChange(setEntry(workspace(), target, rest.join(' ')));
        return 0;
    }

    if (action === 'unset') {
        if (!target) throw new InstallError('Il faut un chemin', 'Exemple : prax config unset Garage.transferFee');
        printChange(unsetEntry(workspace(), target));
        return 0;
    }

    if (action === 'check') {
        const result = checkConfig(workspace());
        log.title('Vérification des réglages de pconfig');
        if (result.applied.length === 0) log.skip('Aucun réglage dans pconfig : la base tourne avec ses valeurs par défaut');
        else log.ok(`Fichiers lus : ${result.applied.join(', ')}`);
        for (const warning of result.warnings) log.warn(warning);
        for (const problem of result.problems) log.fail(problem);
        log.step(result.problems.length === 0 ? 'Réglages valides' : `${result.problems.length} problème(s) : pcore les signalera au démarrage et gardera les valeurs telles quelles`);
        return result.problems.length === 0 ? 0 : 1;
    }

    console.log(CONFIG_USAGE);
    return 1;
}

export function configFindings(resourcesDir: string): { ok: boolean; text: string; fix?: string }[] {
    try {
        const result = checkConfig(loadWorkspace(resourcesDir));
        if (result.problems.length === 0 && result.warnings.length === 0) {
            return [{ ok: true, text: result.applied.length ? `Réglages de pconfig valides (${result.applied.length} fichier(s))` : 'Aucun réglage dans pconfig' }];
        }
        return [
            ...result.problems.map((problem) => ({ ok: false, text: problem, fix: 'Corrige-le avec prax config set, ou remets la valeur par défaut avec prax config unset.' })),
            ...result.warnings.map((warning) => ({ ok: false, text: warning, fix: 'Regarde les lignes [pcore] config au démarrage du serveur, ou lance prax config check.' })),
        ];
    } catch (error) {
        if (error instanceof InstallError) return [{ ok: false, text: error.message, fix: error.hint }];
        throw error;
    }
}
