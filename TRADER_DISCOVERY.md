# Découverte de traders et preuve d'accès aux données

État au 6 novembre 2026 : **BLOCKED pour l'activation réelle**. Ce travail ajoute la découverte en lecture seule et son diagnostic. Il ne sélectionne pas automatiquement les meilleurs traders, ne raccorde pas un classement non démontré au trading et n'active aucun parcours réel.

## Situation effectivement vérifiée

- Render : service `leo-ai-sentinel`, branche `main`, commit déployé `21647491d645c20966c50a698df39cb4bccaf836` (PR #80). Déploiement automatique sur commit dans `main`.
- PR #81 à #86 : ouvertes, non fusionnées lors de la vérification. Leurs corrections sont dans la branche de travail cumulée, pas dans le service actuel.
- Preuve fournie par l'opérateur depuis Render : clés présentes ; GET `/api/v1/me` et `/api/v1/agent-portfolios` → 403 ; GET `/api/v1/trading/info/real/pnl` → 200 avec structure attendue.
- Identité du compte, attribution du PnL, liaison au jeton et droits d'écriture toujours non prouvés. `AGENT` configuré n'est pas une preuve d'identité.
- Le connecteur Render disponible donne accès au service et aux déploiements, mais n'expose pas de terminal ni d'opération permettant d'exécuter ce diagnostic avec les clés. Aucune clé n'a été lue, déplacée ou affichée.
- Aucune lecture eToro authentifiée réalisée depuis cet environnement de travail. Les tests emploient des réponses simulées.

## Opérations officielles ajoutées et réutilisées

Documentation consultée le 6 novembre 2026 :

- [Classements paginés](https://api-portal.etoro.com/api-reference/rankings/get-paginated-investor-rankings) : GET `https://public-api.etoro.com/api/v2/portfolios/rankings` ; `period` obligatoire, `page >= 1`, `pageSize` de 1 à 100. Quota officiel : 60 requêtes / 60 secondes partagé avec les opérations sans quota dédié.
- [Identités publiques](https://api-portal.etoro.com/api-reference/users-info/get-user-profile-and-account-summary) : lecture déjà utilisée par l'observateur, GET `/api/v1/user-info/people?cidList={cid}`.
- [Portefeuille public](https://api-portal.etoro.com/api-reference/users-info/get-user-live-portfolio) : lecture déjà utilisée par l'observateur, GET `/api/v1/user-info/people/{username}/portfolio/live`.

Le client n'accepte pour les classements que les paramètres `period`, `page`, `pageSize` et le filtre booléen strict `popularInvestor=true`, les fenêtres documentées `AbsOneYear` / `AbsTwoYears` et au maximum trois pages. Aucun URL, autre méthode, filtre ou POST fourni par l'appelant n'est accepté. Aucun endpoint de copie ou d'exécution n'est importé. Le filtre officiel limite aux Popular Investors actifs ; leur statut ne prouve pas leur qualité ni la performance future.

Le diagnostic par défaut autorise **onze requêtes GET maximum** :

1. Une page de vingt candidats sur `AbsOneYear`, avec `popularInvestor=true`.
2. Une page de vingt candidats sur `AbsTwoYears`, avec le même filtre officiel.
3. Pour au maximum trois candidats distincts présents dans les deux échantillons, recherche du profil officiel avec le paramètre documenté `usernames`.
4. Pour chacun, lecture de son portefeuille public seulement si le CID et le pseudonyme correspondent au classement.
5. Pour chacun, confirmation du profil pour détecter une course au changement de pseudonyme. Deux lectures de classement plus trois lectures par candidat donnent au maximum onze GET.

L'ordre des candidats par CID sert uniquement à rendre l'échantillonnage reproductible. Le premier candidat vérifié n'est **pas** déclaré meilleur ou sélectionné pour trader. Le rapprochement exige un pseudonyme exact et unique. Le CID du classement doit correspondre au `realCID` ou au `gcid` renvoyé par ce profil. Les deux identifiants doivent rester stables lors de la confirmation. La configuration de l’observateur utilise le `realCID` du profil.

Aucun ajout à `TRADER_OBSERVER_TRADERS_JSON`, `TRADE_ALLOWED_ASSETS`, `TRADE_ALLOWED_CATEGORIES`, aucune modification des plafonds ou des variables Render. La liste des traders effectivement suivis reste celle déjà configurée.

## Ce qui est conservé, et ce qui demeure inconnu

Le module conserve uniquement les champs publics normalisés nécessaires à la recherche : CID fournisseur, pseudonyme, dates d'activité et métriques numériques réellement renvoyées, avec période et date de collecte. Les noms complets, images, AUM, nombres de copieurs, champs inconnus et réponses brutes ne sont pas conservés. Un champ absent reste `null` et figure dans `missingFields`.

Les métriques de rendement, risque, drawdown, rotation, levier et concentration sont des **valeurs rapportées**, pas des mesures recalculées et certifiées. La date du dernier rafraîchissement fournisseur n'est pas documentée dans ce schéma ; la collecte n'est pas une date effective. Les deux fenêtres ont des définitions officielles précises, mais leur date de fin commune n'est pas vérifiée par la réponse. La date de première activité ne prouve pas la profondeur ni la complétude de l'historique.

Les volatilités comparables, coûts pour notre compte, indépendance des sources, historique complet et biais de survivance restent à traiter. Le classement des « meilleurs » reste `UNAVAILABLE`. Le module ne crée aucun score de réussite ni pondération prétendument optimale. Il prépare des **candidats à étudier**, pas une sélection d'investissement.

Les pages manquantes, doublons et total changeant rendent la couverture `PARTIAL`. Une contradiction d'identité ou de métrique pour le même CID et la même période met le candidat en `AMBIGUOUS`. Un renommage entre les deux fenêtres est réexaminé lors d'une future collecte ; il ne crée pas un nouveau trader. Même une énumération achevée n'est pas un instantané temporel garanti.

L'observateur continue à distinguer apparitions de positions et transactions prouvées. Une baisse de pondération ou une disparition dans un portefeuille partiel ne devient jamais une instruction de vente.

## Exécution du diagnostic dans Render, sans déploiement

Depuis le Shell du service disposant déjà des clés, les commandes suivantes extraient uniquement trois modules dans un répertoire temporaire. Elles ne changent pas la branche ni les fichiers du service en cours, ne lancent pas `npm start` et ne recopient aucune clé :

```sh
(
  set -eu
  leo_trader_audit_dir=$(mktemp -d /tmp/leo-traders.XXXXXX)
  for fichier in etoro-trader-discovery.js etoro-trader-observer.js trader-observer.js; do
    curl --fail --silent --show-error --max-time 20 --proto '=https' \
      "https://raw.githubusercontent.com/Chichagoutecha/leo-ai-sentinel/f4b171a2cd2a66a4e73537180be0b873e58c3525/$fichier" \
      -o "$leo_trader_audit_dir/$fichier"
  done
  node "$leo_trader_audit_dir/etoro-trader-discovery.js" --read-only-audit
)
```

Le bloc s'arrête automatiquement si un téléchargement échoue. Ne pas répéter un 401/403. Le programme ne fait aucune répétition automatique, borne chaque lecture à huit secondes et réutilise le client de lecture avec son budget de vingt requêtes par minute. Un 429 arrête la collecte. Les requêtes de diagnostic sont supplémentaires à celles du serveur déjà actif : la limite locale ne coordonne pas les autres processus. Exécuter une seule fois, pas dans une boucle ni une tâche planifiée.

Par défaut, `node etoro-trader-discovery.js` affiche seulement les instructions : **zéro requête**. Seul `--read-only-audit` déclenche la collecte. Les autres arguments sont refusés. L'import n'a aucun effet réseau.

Le rapport v3 donne les motifs précis de rejet des lignes, la lecture du profil et sa correspondance avec le candidat séparément, ainsi que les motifs d'indisponibilité du portefeuille par alias (`CANDIDATE_1`, etc.). Une différence de casse dans le pseudonyme n'est pas assimilée sans preuve à une identité certaine. Le portefeuille n'est pas demandé si le profil contredit le pseudonyme du classement. Un 403 n'est pas répété pour le même candidat ; il n'interdit pas de vérifier un autre candidat distinct. Les 401 et 429 arrêtent la suite. Les identifiants de requête sont des UUID aléatoires de corrélation pour le support, jamais dérivés des secrets.

Le JSON à partager ne contient ni pseudonymes, ni identifiants de compte/trader/jeton, ni positions ou soldes. Il indique méthodes, endpoints génériques, HTTP, structures attendues, dates, couverture et comptes de résultats. Une identité publique de trader vérifiée ne prouve pas l'identité du compte exécutant LEO. Une lecture réussie ne prouve jamais les droits d'ordre.

Le collecteur réutilisable fournit une vue sans I/O, un intervalle de six heures entre collectes dans la même instance et une expiration de vingt-quatre heures. Ces délais bornent les appels et ne représentent pas une cadence optimale de stratégie. Un état restauré ne prouve pas le contexte des clés chargées : une nouvelle collecte est nécessaire. Le CLI isolé ne persiste rien et n'est volontairement pas raccordé au scan, au dashboard ou au scheduler. Une future intégration devra partager l'état et le budget de lecture avec le service existant.

## Raccordement opérationnel restant

1. Obtenir le résultat du diagnostic ci-dessus : accès aux classements, profils et portefeuilles publics. Si refus, faire vérifier les permissions correspondantes dans l'interface officielle eToro ou avec leur support ; ne pas extrapoler à tous les endpoints. Un éventuel accès distinct aux données publiques doit rester séparé du contexte des clés d'exécution.
2. Résoudre la preuve d'identité du compte et du jeton utilisée par le pont d'exécution. Le 403 actuel sur `/me` reste une preuve indispensable manquante ; modifier `AGENT` en `ACCOUNT` ne résout pas cette preuve par lui-même.
3. Qualifier un petit ensemble de traders avec des fenêtres comparables, historique suffisant, baisses, concentration, levier, rotation et recouvrements. Conserver les exclusions et versions de sélection. Une sélection fondée seulement sur le rendement récent ou les copieurs n'est pas recevable.
4. Raccorder uniquement la sélection qualifiée au contexte de décision normal de LEO, déjà préparé dans la PR #85. La politique initiale reste « information complémentaire aux analyses propres de LEO ». Ni achat ni vente forcés par une variation de poids.
5. Vérifier par instrument les autorisations de LEO et l'éligibilité du compte, puis dimensionner avec liquidités, coûts et exposition après opération. Les instruments visibles dans eToro ne sont pas tous autorisés pour ce compte/API. Une découverte de ticker n'ajoute pas une autorisation d'achat.
6. Intégrer les PR #81–#86 et ce travail dans un candidat de livraison revu, conserver SHADOW et effectuer la répétition complète. Une fusion dans `main` déploierait automatiquement : aucune fusion dans `main` pendant ce diagnostic.
7. Présenter pour validation explicite le compte pseudonymisé, traders, instruments, budgets d'entrée et de sortie, réserve, plafond de coûts, cadence et configuration de démarrage exacts. Les valeurs réellement présentes dans Render ne sont pas connues de ce diagnostic ; ne pas confondre valeurs par défaut du code et configuration du service.

Les ventes ne peuvent cibler que les positions effectivement gérées, avec positionId et preuve de propriété. Les positions personnelles restent hors périmètre. Les intentions incertaines restent en réconciliation sans renvoi automatique. La copie native CopyTrader est une fonctionnalité distincte et demeure désactivée.

Conclusion : **BLOCKED pour le réel**, en attente des lectures authentifiées et des preuves listées ci-dessus. Aucun résultat SHADOW ou historique de trader n'est présenté comme une garantie de performance future.

## Vérifications réalisées

- `npm test` : **403 tests réussis**, aucun échec, dont 33 tests de découverte et 26 tests existants de l'observateur.
- `npm run check` : réussite de la vérification syntaxique.
- `git diff --check` : réussite.
- Réponses simulées : fenêtres et pages, données manquantes, doublons et contradictions, changement de pseudonyme, CID ambigu, HTTP 200 sans identité valide, 401/403/429, secrets dans les corps/erreurs, rotation des clés, restauration, expiration, concurrence, décompte des tentatives réseau et refus de toute requête hors liste.
- Le parcours CLI par défaut est testé dans un sous-processus isolé sans identifiants. Le test principal observe exactement cinq GET simulés pour un candidat et onze pour trois candidats, aucun POST/DELETE, aucune sélection de trading et aucune fonction d'ordre.
- Ces résultats ne prouvent ni un accès authentifié aux classements ni une performance de stratégie. Aucun ordre, déploiement, changement de variable Render ou fusion n'a eu lieu.

## Résultats des diagnostics sur Render

Diagnostic v1 communiqué par l’opérateur, le 6 novembre 2026 à **17 h 07 (Paris)** : cinq lectures, classements à un/deux ans HTTP 200 et profils publics HTTP 200 ; portefeuille du candidat HTTP 403. Onze lignes retenues dans chaque fenêtre, une page seulement, aucun trader sélectionné. Les compteurs annonçaient zéro identité liée au classement ; la cause précise n’était pas conservée. Cela établit des accès sélectifs, pas l’absence générale d’accès aux traders. Le caractère privé du candidat et les permissions manquantes ne sont pas prouvés.

Le v1 interrogeait le classement général (plusieurs millions de résultats rapportés), sans le filtre Popular Investor. Le v2 corrige ce périmètre, explique les correspondances et peut vérifier trois candidats distincts. Il ne prétend pas corriger côté client un refus eToro et n’élargit aucune permission. Le v2 a été exécuté sur Render le 9 novembre 2026 à 16 h 34 (Paris). Les deux classements filtrés ont répondu HTTP 200 et annoncé 596 résultats chacun. Vingt candidats ont été collectés. Les trois profils lus par CID ont répondu HTTP 200 avec un pseudonyme différent de celui du classement. Aucun portefeuille n’a été demandé lors de cet essai.

Le v3 utilise la recherche par pseudonyme documentée pour résoudre ces divergences. Il indique quel identifiant du profil correspond au classement, sans divulguer sa valeur. Le résultat authentifié du v3 reste à obtenir sur Render. Le CLI demeure isolé du service et du trading.
