# Finalité des ordres et exécutions partielles

## Version examinée et intégration

3 novembre 2026. `main` distant examiné : `21647491d645c20966c50a698df39cb4bccaf836`, après #80. La PR #81 est **ouverte, en brouillon, non fusionnée**, tête `9eefeb4bfec222f98e5189a269d5b11b03ba037d`. Le checkout initial `298d7e1` a exactement son arbre `8e9670cec91275dab3ffe9b66e0dca3d88497caf`. Cette correction est sur `fix/order-finality`, au-dessus de #81 ; sa PR cible la branche de #81, sans fusion implicite dans main. Le dossier `TRADER_ACTIVATION_REVIEW.md` reste une photographie datée ; le statut global d’activation reste BLOCKED.

Défaut corrigé : `evaluateExecutionEvidence` traitait une apparition de position comme la confirmation d’un achat complet. Le pont acceptait ce booléen et ne suivait pas le reliquat. Désormais la confirmation exige une finalité d’ordre documentée, ses quantités et une correspondance avec le portefeuille.

## Sources officielles relues

- [Consultation des ouvertures](https://api-portal.etoro.com/api-reference/trading--real/get-order-information-and-position-details) : `GET /api/v2/trading/info/orders:lookup`, soit `orderId`, soit `referenceId` (identifiant de requête de soumission). Champs utilisés : identité de compte/instrument, `status`, taille demandée, `positionExecutions`, `openingData`, `frozenAmount`, `totalCosts`. L’exemple associe `status.id=3` à `status.name=Filled`. Aucun autre tableau numérique OPEN n’a été déduit de celui des clôtures.
- [Consultation des clôtures](https://api-portal.etoro.com/api-reference/trading--real/get-close-order-information-and-closed-position-details) : `GET /api/v1/trading/info/real/close-orders/{orderId}`. Le schéma documente `statusID`, les identifiants et les quantités exécutées de `positions[]`. États terminaux : 3, 4, 7, 8, 9, 10 ; attentes : 1, 2, 5, 6, 11. 9 et 10 représentent des fins après exécution partielle. Quota commun annoncé pour ces lectures et l’ancienne consultation d’ouverture : 60 requêtes par 60 secondes.

Aucun de ces endpoints n’a été appelé avec des identifiants réels pendant ce travail. Une incohérence d’exemple ou un champ absent n’est jamais réparé par une hypothèse favorable.

## États et preuves

| Situation | Registre normal / pont | Conséquence |
| --- | --- | --- |
| Intention créée puis envoi préparé | ORDER_INTENT_CREATED / ORDER_SENT | Identifiant de requête et contexte de reprise conservés ; le libellé historique ORDER_SENT marque la frontière durable et non une preuve de réception réseau |
| Accusé seul | ORDER_ACCEPTED_BY_ETORO puis état à vérifier | Aucun booléen d’accusé ne prouve une exécution entière |
| Position visible sans preuve d’ordre | EXECUTION_UNCERTAIN / NEEDS_RECONCILIATION | Aucun passage automatique en CONFIRMED |
| Quantité partielle liée à l’ordre et au portefeuille | ORDER_PARTIALLY_FILLED / NEEDS_RECONCILIATION | Quantité réelle conservée ; aucune nouvelle soumission |
| Ordre Filled dont le portefeuille n’est pas encore conforme | ORDER_FILLED_AWAITING_PORTFOLIO | Reste bloquant jusqu’à preuve de position concordante |
| Ordre Filled et totalité exécutée concordantes | POSITION_CONFIRMED / CONFIRMED | Clôture complète uniquement si la cible exacte n’existe plus |
| Reliquat de clôture rejeté ou annulé après exécution partielle | ORDER_PARTIALLY_FILLED_TERMINAL / PARTIALLY_FILLED_TERMINAL | Ordre terminé, opération non intégralement exécutée, position résiduelle conservée |
| Clôture rejetée/annulée/expirée sans exécution, avec preuve concordante | ORDER_REJECTED / ORDER_CANCELED / ORDER_EXPIRED | Jamais présentée comme une liquidation |
| Schéma, compte, instrument, quantité ou statut non vérifiable | UNKNOWN / EXECUTION_UNCERTAIN | Données manquantes explicites ; pas de renvoi |

Pour les OPEN, les autres statuts numériques ne sont pas présumés identiques à CLOSE. Une exécution partielle observable peut être conservée avec finalité inconnue ; un rejet du reliquat OPEN dont la sémantique n’est pas documentée reste à vérifier, sans libérer l’engagement. Cette limite est volontaire et doit être levée par une source officielle ou une revue, pas par un mapping supposé. Les tests du rejet partiel utilisent le schéma CLOSE documenté.

Une erreur HTTP de soumission 5xx ou 429 reste incertaine ; une réponse de refus 4xx hors 429 est conservée comme refus. Les journaux distinguent désormais ce cas des erreurs réseau. Aucune de ces réponses n’est une preuve de quantité exécutée.

## Modèle conservé et comptabilité

`etoro-order-finality.js` filtre les données avant de retourner un résultat : version, état, terminalité, taille demandée, quantités exécutées cumulées, prix par exécution, frais observables, coûts totaux rapportés, montant gelé observé, reliquat demandé, date de lecture et date effective disponible. Les montants non fournis restent null.

- BUY USD/Underlying/levier 1 : le principal exécuté est **dérivé** des unités liées à cet ordre et de leur prix USD ; ce n’est pas un montant de cash supposé observé. Les frais d’exécution et `totalCosts` sont deux observations séparées, jamais additionnées une seconde fois.
- CLOSE : unités, taux, montants et proceeds rapportés sont conservés séparément. En l’absence de preuve de devise pour les montants hérités, aucun proceeds USD ou frais de clôture nul n’est inventé.
- Le reliquat demandé n’est pas assimilé au montant gelé observé. Un ordre partiellement exécuté peut avoir un reliquat non calculable. « Terminal » signifie qu’il ne peut plus continuer selon le statut documenté, pas que la taille initiale a été entièrement exécutée.
- Le module ne modifie jamais le cash broker et n’ajoute aucune seconde déduction de réserve. La convention de cash disponible du compte reste à vérifier séparément. `additionalCashDeductionUsd:0` décrit seulement l’absence de mutation par ce module.
- Les ordres et intentions sont reliés par l’identifiant broker, y compris `intent.response.orderId`. Avec preuve récente, compte concordant et portefeuille déjà apparié, l’exposition en attente retient uniquement le principal non exécuté : exemple synthétique demande 10, exécution 4, attente 6. Elle ne compte pas 4 détenus + 10 attendus. Réponse périmée, compte différent, montant contradictoire ou terminal encore listé en attente ⇒ couverture incomplète ; jamais une exposition inconnue transformée en zéro.

La quantité détenue est issue du portefeuille ; les quantités cumulées d’un même ordre ne sont pas additionnées entre deux lectures. Les doublons de positions/exécutions sans identifiant distinct fiable sont rejetés. Une correction qui réduit la quantité cumulée ou modifie son montant à quantité identique suspend la finalité, conserve la dernière observation vérifiée et exige une revue. Une nouvelle lecture favorable n’efface pas automatiquement cette contradiction.

## Reprise et périmètre géré

La référence de comparaison reste le snapshot **avant la soumission initiale**, même après une exécution partielle ou un redémarrage. Cela permet de vérifier les quantités cumulées sans compter deux fois un complément tardif.

Le pont recalcule lui-même la preuve de correspondance. Il ne fait plus confiance au seul `confirmed:true` d’un adaptateur. Un achat partiel attribuable à une seule position entre dans le registre à ses unités réelles, avec `RECONCILIATION_REQUIRED` tant que l’ordre reste incertain. Une clôture partielle réduit les unités conservées ; elle ne supprime pas la position. Après fin partielle prouvée et portefeuille concordant, le reliquat détenu peut redevenir `VERIFIED_MANAGED`. Plusieurs exécutions créant plusieurs positions restent non adoptées par le pont actuel et nécessitent une réconciliation : aucun lot fictif par signal n’est créé.

Avant HTTP, le parcours stratégique conserve sa réservation et son intention durables. BUY et SELL normaux, ainsi que le parcours DEMO, vérifient aussi désormais que la compaction conservera l’intention préparée et sa référence, puis attendent la sauvegarde avant l’envoi. Échec de stockage ⇒ aucun envoi. Les payloads et armements d’ordres sont inchangés.

Les anciennes confirmations dépourvues de preuve de finalité sont remises en incertitude lors de la migration du registre ; le pont restaure également ses anciennes opérations non prouvées en NEEDS_RECONCILIATION. Cela peut nécessiter une revue des anciennes opérations, notamment si leur compte ou identifiant broker n’est plus disponible. Les compteurs historiques antérieurs ne sont pas réécrits comme s’ils constituaient de nouvelles preuves.

Les intentions du nouveau format ne passent plus automatiquement en NO_EFFECT au seul motif du délai écoulé, du cash inchangé ou d’un snapshot identique. Ce garde intervient avant les mécanismes hérités de résolution ACK/no-effect. Les ordres incertains ne sont pas supprimés à l’expiration du TTL, et aucune erreur ou reprise ne réémet une soumission, une annulation ou une clôture.

## Lectures nécessaires, bornes et limites d’accès

Le nouveau client n’expose que deux chemins GET construits à partir d’identifiants validés. Il n’accepte pas d’URL arbitraire ni de méthode d’exécution ; les redirections sont refusées. Au maximum 6 lectures/minute localement et dans le budget conservé par les intentions, 10 secondes entre lectures d’une même intention, 3 intentions au plus par passe de réconciliation et expiration réseau 5 secondes. Aucun retry interne. Les tentatives transitoires suivantes passent uniquement par la réconciliation existante et ses budgets.

Les dates de tentative et de prochaine lecture sont persistées avant la lecture, afin de borner aussi la reprise après redémarrage. Cette écriture supplémentaire du stockage existant est nécessaire à ce budget durable ; elle n’est pas une nouvelle collecte fournisseur. Les réponses 401/403 suspendent le client et imposent une revue conservée dans l’intention ; 429 reporte la lecture d’au moins une minute. Ni erreur brute ni en-tête n’est sauvegardé. Le verrou distribué et la coordination des autres consommateurs du quota eToro restent à démontrer : la réserve locale n’est pas une preuve de quota global multi-instance.

Le compte est comparé uniquement avec des champs explicitement nommés et observés dans le préflight (`accountId`, `portfolioId`, `gcid`, ou `CID` selon le contrat). Aucun identifiant générique/configuré n’est supposé équivalent. Si le PnL ne fournit pas un champ permettant la liaison, la lecture n’est pas déclenchée utilement et la confirmation reste indisponible. Le lien du secret au jeton demeure non vérifié comme dans le diagnostic précédent.

Une ouverture sans orderId peut être recherchée par son identifiant de requête initial grâce au GET officiel `referenceId`. Le corps n’est pas supposé contenir un champ referenceId non documenté : la liaison provient de la requête officielle exacte. La clôture héritée exige un orderId ; si sa réponse a été perdue sans identifiant récupérable, le module n’invente aucun endpoint de recherche.

Cette intégration de lecture est **REAL seulement**. Aucun endpoint DEMO de finalité n’a été supposé ; une soumission DEMO future ne pourrait pas être déclarée intégralement exécutée par la seule apparition d’une position. Le mode SHADOW reste sans appel d’exécution ni nouveau lookup. Les substitutions UCITS ou produits non reconstitués peuvent rester indisponibles si leurs identifiants/produits ne concordent pas ; aucun alias n’est appliqué pour contourner le contrôle.

Les réponses ne conservent pas de token opaque, texte libre de broker ou clé ; le compacteur historique retient seulement la présence d’un token. Les identifiants nécessaires aux rapprochements restent internes au stockage protégé existant ; aucun secret ou identifiant réel de compte n’est imprimé dans ce rapport.

## Tests et résultats

Résultats réellement obtenus :

- `npm ci --ignore-scripts --no-audit --no-fund` : réussi.
- `npm run check` : réussi.
- Tests ciblés `test-etoro-order-finality.js` : **18/18**. La commande dédiée est `npm run test:order-finality`.
- `npm test` : **337/337**, zéro échec. Les tests antérieurs d’apparition/disparition de positions sont conservés et corrigés pour ne plus les assimiler à une preuve de fin d’ordre.
- `test:ai-preload`, `test:ai-context-preload`, `test:production-preflight`, `test:ai-cost-concurrency`, `test:ai-cost-missing-usage` : réussis. Quatre suites 1/1 ; préflight code 0.
- Treize blocs d’invariants statiques du workflow : réussis localement, comparaison avec le parent `298d7e1` de même arbre que #81 ; fetch et commandes de test déjà exécutées omis de cette répétition statique.
- `git diff --check` : réussi. Commande start, armements, listes autorisées, plafonds, payloads d’ordres et `package-lock.json` inchangés.

Scénarios : achat partiel puis complément tardif, clôture partielle puis rejet du reste ou fin complète, incohérences d’identifiants/quantités/statuts, correction régressive, données et coûts manquants, lecture par référence officielle, doublons, limites de lecture, 401/403/429, panne réseau, budget durable après redémarrage, absence de double comptage, migration des anciennes confirmations et échec de persistance avant envoi REAL/DEMO. Les vrais exécuteurs sont aussi évalués en VM, pour les parcours stratégiques et normaux, avec transports et stockage remplacés.

Les fixtures sont synthétiques et les transports remplacés ; **0 appel broker réel, 0 ordre REAL/DEMO**. Aucune permission broker, donnée de production ou performance financière n’est validée par ces tests. La CI distante de la nouvelle PR doit être consultée séparément.

Le contre-exemple de #80 est remplacé par un test de correction utilisant le véritable évaluateur normal : une position de 0,4 unité sans preuve de fin ne devient pas CONFIRMED. Le JSON reproductible de répétition est actualisé ; le scénario de plafond de clôture reste un `BLOCKER_REPRODUCED`, sans prétendre lever les autres blocages d’activation.

Fichiers concernés : module `etoro-order-finality.js`, fixtures `order-finality-fixtures.js`, tests `test-etoro-order-finality.js`, `index.js`, `trader-execution-bridge.js`, `trader-exposure-link.js`, fixtures et tests antérieurs du pont et de la revue, répétition et son JSON, `package.json`, workflow de qualité et ce document.

Aucun ordre réel/DEMO, copie, activation LIVE, modification Render ou déploiement. Aucune fusion de #81 ou de cette correction. **Activation réelle : BLOCKED tant que les preuves indispensables manquent.**
