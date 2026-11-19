# Version Internet (Vercel) de tournoi-pronostics

Ce fork expose l'application sur Internet via Vercel, au lieu d'un PC sur un WiFi local.
**Aucun fichier du projet d'origine n'est modifié** (`server.js`, `public/`, lanceurs…) :
tout est ajouté à côté, ce qui permet de récupérer ses évolutions sans conflit.
Le mode local d'origine (`LANCER-*.sh/.bat/.command`) marche toujours.

## Comment ça marche

| Problème sur Vercel | Solution de la couche Vercel |
|---|---|
| Pas de disque persistant, `data.json` serait perdu | `data.json` est stocké dans Redis (Upstash), lu avant chaque requête et réécrit après |
| Plusieurs instances en parallèle | Écriture « optimiste » avec numéro de version : en cas de croisement, la requête est rejouée, rien n'est perdu |
| `config.json` contient le mot de passe admin | Fabriqué à partir des variables d'environnement Vercel, jamais dans le dépôt |
| Pas de serveur qui reste allumé | `server.js` est exécuté dans un bac à sable pour chaque requête (`vercel/adaptateur.js`) ; seul son `handler` est utilisé |
| Code à 4 chiffres attaquable depuis Internet | 10 essais ratés max par pseudo et par IP toutes les 15 min (idem pour le mot de passe admin) |
| Page admin qui affiche `http://192.168…:3000` | Remplacé par l'adresse du site |

Fichiers ajoutés : `api/tournoi.js`, `vercel/*`, `vercel.json`, `.github/workflows/*`, ce fichier, et 3 lignes dans `.gitignore`.

## Branches

- **`main`** : copie exacte du projet d'origine. Ne jamais y travailler, le workflow la met à jour.
- **`release`** : `main` + couche Vercel. Branche par défaut du dépôt, déployée en production.
- **`synchro/amont-<commit>`** : créées par le workflow pour chaque synchro, avec une préproduction Vercel.

## Mise en place (une seule fois)

### 1. GitHub

1. Forker `20Sy/tournoi-pronostics` (ou, si c'est votre propre dépôt, en créer un nouveau et y pousser `main`).
2. Ajouter la branche `release` :
   ```bash
   git clone https://github.com/<vous>/<fork>.git && cd <fork>
   git checkout -b release
   git am /chemin/vers/0001-couche-vercel.patch
   git push -u origin release
   ```
3. **Settings > General > Default branch** : `release` (obligatoire pour que le bouton « Run workflow » apparaisse).
4. **Settings > Actions > General > Workflow permissions** : *Read and write permissions* et cocher
   *Allow GitHub Actions to create and approve pull requests*.
5. Conseillé : **Settings > Rules > Rulesets** sur `release` : *Require a pull request before merging*.
   Ne protégez pas `main` (le workflow doit pouvoir la pousser).

Un dépôt public est en lecture seule pour les autres : seuls vous et vos collaborateurs pouvez pousser.

### 2. Vercel

1. **Add New > Project**, importer le fork. Lors de l'installation de l'app GitHub de Vercel,
   choisir *Only select repositories* et ne donner que ce dépôt.
   Framework : *Other*, laisser les commandes vides (tout est dans `vercel.json`).
2. **Settings > Environments > Production > Branch Tracking** (selon l’interface : *Settings > Git > Production Branch*) : `release`.
3. **Settings > Git > Ignored Build Step** : *Custom*, commande `[ ! -f vercel.json ]`
   (la branche miroir `main` n'a pas de `vercel.json` : inutile de la déployer).
4. **Storage** : ajouter *Upstash for Redis* (Marketplace) et le connecter au projet pour
   *Production* et *Preview*. Les variables `KV_REST_API_URL` / `KV_REST_API_TOKEN`
   (ou `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) sont ajoutées automatiquement.
5. **Settings > Environment Variables** (cocher *Sensitive* pour le mot de passe) :

   | Variable | Obligatoire | Exemple |
   |---|---|---|
   | `ADMIN_PASSWORD` | oui | une longue phrase de passe, **différente** pour Preview |
   | `NOM_TOURNOI` | non | `Tournoi Drone FPV 2027` |
   | `DELAI_MINUTES` | non | `15` |
   | `TOURNOI_CONFIG` | non | JSON fusionné dans la config, pour de futurs réglages de l'origine |

6. Laisser activés **Deployment Protection > Vercel Authentication** (préproductions privées)
   et **Git Fork Protection** (une PR venant d'un inconnu ne peut pas lire vos variables).
7. Redéployer. Spectateurs : `https://<projet>.vercel.app`, admin : `https://<projet>.vercel.app/admin`.

Production et préproduction utilisent des clés Redis séparées (`tournoi:production:…` /
`tournoi:preview:…`) : tester une synchro ne touche jamais aux données du vrai tournoi.

### Ce qui n'est jamais dans le dépôt public

Mot de passe admin, jetons Redis, identifiants du projet Vercel (`.vercel/` est ignoré par git) :
tout reste dans Vercel. Aucun jeton Vercel n'est nécessaire côté GitHub, le déploiement passe par
l'intégration Git de Vercel. Seules l'adresse publique du site et celles des préproductions
(protégées par connexion Vercel) apparaissent dans les PR.

## Récupérer les évolutions du projet d'origine

**Actions > Synchroniser avec le projet d'origine > Run workflow**

1. `main` est avancée sur la dernière version de l'origine.
2. S'il y a du nouveau, une branche `synchro/amont-<commit>` est créée avec la fusion dans `release`,
   les tests de la couche Vercel sont lancés, et une **Pull Request** vers `release` est ouverte
   avec la liste des nouveautés et le résultat des tests.
3. Vercel construit la préproduction de cette branche : vérifiez-la (lien dans la PR).
4. Fusionnez la PR : Vercel déploie en production.

Option *fusion_directe* : si pas de conflit et tests OK, la fusion est faite tout de suite (sans PR).
À éviter pendant un tournoi.

Cas particuliers :
- **Conflit** : la PR contient la version d'origine seule et GitHub affiche les conflits à résoudre.
  En pratique seul `.gitignore` est partagé avec l'origine.
- **Tests en échec** : `server.js` a changé d'une façon que l'adaptateur ne gère pas encore
  (voir ci-dessous). Corriger `vercel/adaptateur.js` dans la branche de synchro avant de fusionner.
- **L'origine ajoute ses propres workflows GitHub** : le jeton par défaut ne peut pas les pousser.
  Créer un *fine-grained token* limité à ce dépôt (Contents, Pull requests et Workflows en écriture)
  et l'enregistrer en secret d'Actions sous le nom `JETON_SYNCHRO`.
- Autre dépôt d'origine : variable d'Actions `DEPOT_AMONT` (ex. `20Sy/tournoi-pronostics`).

### Ce sur quoi repose l'adaptateur

Les évolutions de l'origine sont reprises sans rien changer tant que `server.js` :
- crée son serveur avec `http.createServer(handler)` ;
- lit et écrit ses données dans `data.json` et ses réglages dans `config.json` avec `fs` synchrone ;
- expose son API sous `/api/…` et ses pages dans `public/`.

Nouvelles routes, nouvelles règles de calcul, pages modifiées : tout passe automatiquement.

## Limites à connaître

- Chaque spectateur interroge le serveur toutes les 5 s : une exécution de fonction Vercel et
  une commande Redis à chaque fois (environ 150 000 pour 50 spectateurs pendant 4 h).
  Vérifier les quotas gratuits de Vercel et d'Upstash pour la taille de votre tournoi. Le plan
  Hobby de Vercel est réservé à un usage non commercial.
- Upstash limite la taille d'une requête : `data.json` est compacté avant envoi, ce qui suffit
  largement pour un tournoi de quelques centaines de spectateurs.
- L'heure de référence anti-triche est celle des serveurs Vercel (synchronisée, donc fiable).
- Remise à zéro : bouton admin habituel, ou supprimer les clés `tournoi:production:*` dans Upstash.

## Tester en local

```bash
node --test vercel/*.test.js
```
