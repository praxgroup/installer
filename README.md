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
| `prax install` | se connecte au compte client (code à entrer sur prax-studio.fr, ou jeton `--token` / `PRAX_INSTALL_TOKEN`), télécharge la base et installe FXServer, la base de données, `server.cfg` et txAdmin |
| `prax doctor` | cherche ce qui empêche le serveur de démarrer, réglages de `pconfig` compris |
| `prax config get [chemin]` | valeur d'un réglage, sa valeur par défaut, son type et son aide ; sans chemin, la liste des réglages |
| `prax config set <chemin> <valeur>` | modifie un réglage dans `pconfig`, après l'avoir vérifié avec le schéma de la base |
| `prax config unset <chemin>` | remet un réglage à sa valeur par défaut |
| `prax config check` | vérifie tous les réglages de `pconfig`, avec les mêmes messages que la base au démarrage |
| `prax version` | affiche la version |

`prax config` n'écrit jamais dans `pcore` : les réglages vont dans `pconfig`, qu'une mise à jour ne touche pas. Un chemin s'écrit comme en Lua (`Garage.transferFee`, `Garage.garages["Pillbox Hill"].label`, `Garage.defaultColors[2]`), une valeur aussi (`750`, `true`, `"texte"` ou `texte`, `vec3(1, 2, 3)` ou `1, 2, 3`, `{ label = "Garage" }`). Modifier un élément d'une liste écrit la liste entière dans `pconfig`, car une liste y est toujours remplacée en entier. Les commentaires d'un fichier de `pconfig` ne sont pas gardés quand `prax config` le réécrit : l'ancien fichier est copié en `.bak`.

## Ce que fait `prax install` sur la machine

- **Base de données** (`dbMode`) :
  - `install`, par défaut quand rien n'écoute sur le port 3306. Sous Windows, il prend la dernière version LTS de MariaDB pour Windows, en zip, sur `downloads.mariadb.org`, et vérifie son empreinte. MariaDB est installé dans le dossier du serveur (`mariadb/`), sans rien installer dans Windows et sans droits administrateur. Il n'écoute que sur 127.0.0.1, son compte `root` reçoit un mot de passe aléatoire, et `start.bat` le lance avant FXServer, sans fenêtre : fermer une fenêtre ne coupe donc plus la base. `start-mariadb.bat` relance MariaDB seul s'il s'est arrêté, sans toucher à FXServer. `--mariadb-from <dossier>` utilise un MariaDB déjà extrait au lieu de le télécharger. Sous Linux, il installe le paquet `mariadb-server` (apt, dnf ou yum, avec les droits root) et crée la base par la socket de `root`.
  - `create` : crée la base dans un MariaDB existant, avec son compte administrateur.
  - `existing` : une base déjà créée, par exemple chez un hébergeur. C'est le choix par défaut dans un conteneur.
  
  Dans tous les cas, la base reçoit deux utilisateurs à elle (`<base>_server` et `<base>_readonly`), et l'installeur ne modifie jamais un utilisateur qu'il n'a pas créé.
- **Pare-feu** (`openFirewall`, `openTxAdminPort`) : il ouvre le port du jeu (TCP et UDP), et celui de txAdmin seulement si on le demande. Ça passe par une règle `netsh` sous Windows, et par `ufw` ou `firewalld` sous Linux. Sans droits administrateur, il affiche les commandes exactes à lancer et ne change rien.
- **Démarrage automatique** (`autostart`) :
  - Windows en administrateur : une tâche planifiée au démarrage de la machine ;
  - Windows sans droits : un lanceur dans le dossier Démarrage de la session ;
  - Linux en root : un service systemd `prax-<dossier>`, lancé avec le compte qui a utilisé `sudo`.
- **Premier lancement** (`startNow`) : il démarre le serveur et attend qu'il réponde sur `info.json` avec pcore et pguard démarrés, pendant 5 minutes au plus.

Dans Pterodactyl et Docker, il ne touche ni au pare-feu, ni au démarrage, ni à la base : c'est le panel ou le `docker-compose.yml` qui s'en charge.

Une installation sans questions (hébergeurs, Docker) passe par un fichier de réponses (`--answers`, modèle dans `answers.example.json`) ou par des variables d'environnement `PRAX_*` (`PRAX_DB_HOST`, `PRAX_CFX_LICENSE_KEY`…), avec `--yes`.

## Adresses contactées

| Adresse | Pourquoi |
|---|---|
| `changelogs-live.fivem.net` | connaître la version recommandée de FXServer |
| `runtime.fivem.net` | télécharger FXServer |
| `downloads.mariadb.org` | sous Windows, en mode `install` : version LTS de MariaDB et son archive |
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
