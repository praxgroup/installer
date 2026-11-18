# Programme d'installation Prax

`prax` installe et configure la base FiveM de Prax Studio, sur Windows et sur Linux x64 : FXServer, base de données, `server.cfg` et txAdmin déjà réglé pour la base. Son code est public pour que les acheteurs et les hébergeurs puissent relire ce qu'il fait.

Ce dépôt ne contient aucun fichier de la base : celle-ci est téléchargée depuis le compte client de l'acheteur, pour sa licence.

## Installer

Windows (PowerShell) :

```powershell
irm https://prax-studio.fr/install.ps1 | iex
```

Linux x64 :

```sh
curl -fsSL https://prax-studio.fr/install.sh | sh
```

Les deux scripts téléchargent la dernière version publiée ici, vérifient son empreinte SHA-256, puis lancent `prax install`.

macOS : Cfx ne publie pas FXServer pour Mac. Il faut passer par l'image Docker.

## Commandes

| Commande | Rôle |
|---|---|
| `prax install` | installe la base, FXServer, la base de données, `server.cfg` et txAdmin |
| `prax doctor` | cherche ce qui empêche le serveur de démarrer, réglages de `pconfig` compris |
| `prax config get [chemin]` | valeur d'un réglage, sa valeur par défaut, son type et son aide ; sans chemin, la liste des réglages |
| `prax config set <chemin> <valeur>` | modifie un réglage dans `pconfig`, après l'avoir vérifié avec le schéma de la base |
| `prax config unset <chemin>` | remet un réglage à sa valeur par défaut |
| `prax config check` | vérifie tous les réglages de `pconfig`, avec les mêmes messages que la base au démarrage |
| `prax version` | affiche la version |

`prax config` n'écrit jamais dans `pcore` : les réglages vont dans `pconfig`, qu'une mise à jour ne touche pas. Un chemin s'écrit comme en Lua (`Garage.transferFee`, `Garage.garages["Pillbox Hill"].label`, `Garage.defaultColors[2]`), une valeur aussi (`750`, `true`, `"texte"` ou `texte`, `vec3(1, 2, 3)` ou `1, 2, 3`, `{ label = "Garage" }`). Modifier un élément d'une liste écrit la liste entière dans `pconfig`, car une liste y est toujours remplacée en entier. Les commentaires d'un fichier de `pconfig` ne sont pas gardés quand `prax config` le réécrit : l'ancien fichier est copié en `.bak`.

Une installation sans questions (hébergeurs, Docker) passe par un fichier de réponses (`--answers`, modèle dans `answers.example.json`) ou par des variables d'environnement `PRAX_*` (`PRAX_DB_HOST`, `PRAX_CFX_LICENSE_KEY`…), avec `--yes`.

## Adresses contactées

| Adresse | Pourquoi |
|---|---|
| `changelogs-live.fivem.net` | connaître la version recommandée de FXServer |
| `runtime.fivem.net` | télécharger FXServer |
| `github.com/praxgroup/installer` | télécharger le programme lui-même |
| `api.prax-studio.fr` | connexion au compte client, licence, adresses de téléchargement de la base |

Les secrets (clé de licence, mots de passe de la base, clé Cfx) ne quittent jamais la machine, sauf la licence envoyée à l'API Prax.

## Développement

```sh
npm ci
npm run setup
node src/main.ts install --from <dossier build/<version>>
npm run check
npm run audit
```

`npm run setup` installe les hooks git : l'audit tourne à chaque commit et à chaque push. Il refuse tout fichier de la base, tout secret, toute adresse IP publique et tout commentaire dans le code.

Les versions sont publiées par GitHub Actions à chaque tag `vX.Y.Z` : exécutables compilés avec Bun et leurs empreintes.

## Licence

Tous droits réservés (voir [LICENSE](LICENSE)). Le code est public pour être relu. On peut lancer le programme pour installer la base Prax, et un hébergeur peut proposer l'installation à ses clients sans la modifier. Tout autre usage demande l'accord écrit de Prax Studio.
