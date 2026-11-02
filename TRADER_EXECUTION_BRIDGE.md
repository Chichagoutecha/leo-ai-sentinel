# Raccordement de la stratégie traders aux exécuteurs normaux

## État examiné et portée

Base distante examinée : `main` au commit `9af237b2775075d3f33c2b908a893fb58da24405`, après fusion des PR #77/#78. Le checkout local de départ `78a1d84` avait le même arbre. Aucun résultat SHADOW de production, droit effectif du compte ou résultat d'ordre n'a été consulté dans cet environnement. Les simulations de tests ne constituent pas une validation de mise en production.

`trader-execution-bridge.js` orchestre des propositions typées. Il n'importe ni client eToro, ni HTTP, ni secrets, ni scheduler. Dans `index.js`, l'adaptateur utilise exclusivement les `executeBuy` et `executeSell` existants. Le scan peut réévaluer la politique consultative sur ses données déjà lues, placer les propositions admissibles en file puis traiter au maximum une opération. Les consultations du statut ne déclenchent pas cette évaluation. Aucun second appel IA ou collecteur n'est ajouté.

## Capacités et protections

| Opération | Comportement préparé | Limite |
| --- | --- | --- |
| Acheter | Achat normal v2, instrument de WATCHLIST et listes autorisées inchangées | Aucun achat sur un instrument possédant déjà une position personnelle, ancienne ou copiée non gérée |
| Renforcer | Même exécuteur BUY, nouveau signal LEO, réconciliation exacte du changement de position | Une modification de position existante doit correspondre à un périmètre déjà vérifié ; sinon arrêt |
| Réduire partiellement | Proposition conservée avec veto explicite | `PARTIAL_CLOSE_NOT_RELIABLY_SUPPORTED`, jamais remplacé par une liquidation complète |
| Sortir | Clôture complète du `positionId` géré exact, avec quantité détenue identique à la proposition | Pas de vente à découvert, ni de fermeture d'une autre ligne partageant le symbole |

Chaque opération exige : autorisation de mode LIVE et armement existants, armement distinct de la stratégie, autorisation du sens, identité/jeton établis, validation chronologique approuvée pour la version et configuration exactes, instrument autorisé, éligibilité compte/sens/produit/devise, cours et preuves récents, dérive de prix bornée depuis la proposition, coûts complets estimés, minimums, cash/réserve, exposition marginale complète, absence d'ordres incertains, cadence et plafonds. Une preuve inconnue ne devient ni zéro ni une permission.

Le contrôleur de risque normal est appelé par candidat, y compris SELL, puis de nouveau avec le portefeuille et les cours du préflight normal. Une modification de taille n'est pas silencieusement acceptée : elle invalide les preuves de coûts/risque liées au montant. La requête réelle est comparée au sens, actif, montant ou position/quantité de la réservation ; une métadonnée SELL ne peut pas valider un BUY, ou une autre cible SELL.

## Entrées et sorties indépendantes

Les ventes en file passent avant les achats et n'exigent pas l'armement BUY. Désactiver les entrées ne retire pas l'autorisation distincte des sorties. Une proposition SELL peut donc être traitée lorsque la nouvelle analyse n'a aucun achat à proposer. Une simple disparition du portefeuille public ne crée toujours pas une transaction prouvée ou une proposition de liquidation.

Les sorties de protection approuvées par le parcours LEO préexistant conservent leur chemin normal si le pont n'a envoyé aucune opération. Leur présence empêche l'entrée stratégique de prendre leur place. Ce raccordement ne révoque pas rétroactivement les autorisations des routes manuelles et du parcours LEO antérieur : leur périmètre reste celui de la politique existante. Une vente issue du nouveau module doit, elle, respecter le registre géré et la cible exacte.

## Périmètre géré et provenance

Une position personnelle, copiée ou issue d'un ancien achat de LEO n'est jamais adoptée automatiquement. L'initialisation du registre vide exige une revue explicite de l'historique et du contexte de compte/jeton ; aucune route HTTP de cette branche ne la réalise. Une référence de compte configurée seule n'est pas une preuve d'identité.

Une nouvelle position entre dans le registre uniquement si l'intention est liée à la proposition, si le vérificateur constate un changement non ambigu de position, et si le `positionId` du résultat broker correspond à cette position. Accusé seul, réponse sans position liée, plusieurs changements possibles, identité contradictoire ou unités inconnues imposent `NEEDS_RECONCILIATION`. Les comparaisons de quantité sont conservatrices et exactes : la précision des snapshots existants peut donc bloquer des cas valides, sans les arrondir à l'avantage d'une clôture.

Plusieurs signaux et renforts peuvent contribuer à une même position broker. Le registre conserve leurs identifiants d'opération et observations sources ; il ne leur attribue pas des lots indépendants ou des fractions appartenant à un trader. Une sortie complète nécessite une nouvelle justification LEO et toutes les protections, pas simplement la vente d'une source. Une mutation manuelle des unités suspend de fait la gestion de cette ligne jusqu'à revue ; elle n'est pas assimilée à un renfort du module.

La trace comporte décision LEO stable, proposition, version/hash de configuration publique, sources, décision finale, veto, preuves datées d'approbation, réservation, intention normale et preuve de résultat. Le hash de décision porte uniquement sur date/instrument/sens publics de la décision ; aucune empreinte de secret n'est créée par le pont. Les erreurs d'adaptateur sont réduites à un état d'incertitude, pas journalisées brutes.

## Durabilité, reprise et arrêt

La réservation est persistée avant d'appeler l'exécuteur. Celui-ci crée son intention normale, lie `proposalId`/`strategyOperationId` et persiste la frontière d'envoi avant HTTP. Les écritures du stockage existant sont sérialisées dans le processus ; une compaction qui ne conserve pas une réservation active ou son intention fait échouer cette sauvegarde. Échec de persistance, arrêt ou preuve périmée bloque l'envoi.

Au redémarrage, toute opération non terminale passe à `NEEDS_RECONCILIATION`, même si aucun identifiant broker n'a été obtenu. Aucun renvoi n'est automatique. La réconciliation existante peut mettre à jour le pont uniquement avec une intention explicitement liée et des snapshots ; elle ne soumet aucun nouvel ordre. Un résultat confirmé doit correspondre au même identifiant d'intention. Rejets et confirmations restent des tombstones et ne permettent pas de rejouer la même décision sous un nouveau UUID.

La sérialisation locale n'est pas un verrou distribué. Une garantie de processus écrivain unique reste obligatoire ; le runtime ne la présume pas et la retourne actuellement comme non vérifiée. Les tests de concurrence couvrent le contrôleur local, pas une preuve de coordination multi-réplique.

`POST /trader-execution-stop` avec `{ "stop": true }`, protégé par le secret existant, persiste un arrêt du nouveau pont. Il n'existe aucune route de reprise, d'armement, de soumission d'ordre ou de modification des preuves financières dans cette branche. L'arrêt est contrôlé avant réservation et avant envoi ; il ne peut pas annuler une requête déjà transmise. Les contrôles manuels préexistants restent distincts.

La file est bornée à 50 propositions, le registre à 200 opérations ; aucune tombstone n'est évincée pour autoriser de nouveaux envois. La section vise 60 Ko (12 Ko dans le fallback critique). Si l'état ne tient plus, le pont retourne un marqueur d'arrêt `ARCHIVE_REQUIRED_NO_AUTOMATIC_RESET` et exige une revue/archivage. Ce marqueur ne vaut pas historique complet et ne permet jamais de reconstruire automatiquement un registre vide puis de reprendre.

## Inactivité par défaut et preuves restant à raccorder

Tous les nouveaux paramètres sont lus mais aucune variable Render n'est créée ou modifiée :

- `TRADER_EXECUTION_ENABLED`, `TRADER_EXECUTION_ENTRIES_ENABLED`, `TRADER_EXECUTION_EXITS_ENABLED` : faux par défaut ;
- `TRADER_EXECUTION_CONFIRMATION` : confirmation distincte de l'armement LIVE existant ;
- `TRADER_EXECUTION_EMERGENCY_STOP` : arrêt supplémentaire ;
- `TRADER_EXECUTION_MAX_COST_USD` : plafond initial nul, sans supposer que les coûts le sont ;
- `TRADER_EXECUTION_MAX_EXIT_NOTIONAL_USD` : plafond de clôture distinct, par défaut égal au plafond BUY existant.

Ces paramètres seuls ne permettent pas une activation. L'état démarre avec `recoveryRequired`. Le runtime garde le lien jeton/compte et l'écrivain unique comme non vérifiés, et ne fabrique pas de validation SHADOW. Les adaptateurs cache-only `traderAdvisoryCostEvidence`, `traderAdvisoryEligibilityEvidence`, `traderExecutionSizingEvidence` et la preuve de release revue ne sont pas renseignés par les sources actuelles. Leur contrat est exercé avec fixtures, mais les preuves réelles et leurs permissions restent à vérifier dans l'environnement autorisé. Sans elles, aucune opération ne sort du pont, même si ses interrupteurs sont changés.

Les coûts requis doivent être liés au compte, au sens et au montant ou aux unités. L'exposition est recalculée par la prévisualisation existante ; compositions inconnues et risques non reconstitués empêchent une autorisation. Le cache d'éligibilité n'est pas rafraîchi automatiquement et n'ajoute aucun actif aux listes. Un compte agent et le compte propriétaire/copie ne sont pas interchangeables : le solde virtuel agent n'est pas le capital personnel ni le risque réel de réplication. Les permissions, tailles copiées et contraintes du compte restent à établir séparément.

## Sources officielles consultées

- https://api-portal.etoro.com/core/guides/market-orders : ouverture BUY v2 et distinction ouverture/clôture ;
- https://api-portal.etoro.com/api-reference/trading--real/close-position-by-units : `positionId`, champ requis `InstrumentId`, `UnitsToDeduct`, réponse 200 de soumission et non preuve de clôture ;
- https://api-portal.etoro.com/api-reference/agent-portfolios/create-agent-portfolio-v2 : scopes nommés en v2 et distinction capital du propriétaire/solde virtuel agent ;
- https://api-portal.etoro.com/api-reference/agent-portfolios/get-agent-portfolios : métadonnées des comptes et jetons, sans preuve automatique que le secret chargé correspond à une entrée.

Le corps de clôture existant est complété par `InstrumentId` conformément au schéma actuel ; le garde CI est adapté à ce contrat précis, pas supprimé. La réduction partielle, bien que documentée côté API, reste bloquée car le vérificateur et la gestion de scope du dépôt garantissent seulement la clôture complète. Aucun endpoint d'ordre, copie, création de portefeuille ou gestion de jeton supplémentaire n'est introduit ou appelé pour cet audit. Le seul rafraîchissement de données ajouté à une éventuelle sortie stratégique est la relecture de cours par le client normal, nécessaire au contrôle de prix ; il ne se produit pas dans ce travail.

## Vérifications

`npm run test:trader-execution`, `npm run check`, `npm test`, `git diff --check` et contrôles du workflow. Le broker est simulé : les exécuteurs réels sont également évalués dans une VM isolée, avec transports et stockage remplacés, sans modifier les variables LIVE du processus et sans réseau. Les scénarios couvrent achat, renfort, réduction bloquée, sortie exacte, opposition, minimums, coûts/cash/exposition, déduplication, erreurs réseau, ACK, réponses ambiguës, persistance, redémarrage et réconciliation. Aucun serveur de production, ordre réel/DEMO, copie ou déploiement n'est démarré.

Résultats vérifiés : 23 tests ciblés réussis ; suite complète 305/305 ; syntaxe et espacement réussis ; préchargements et invariants du workflow réussis. Commande start, listes autorisées et constantes d’armement LIVE inchangées. Aucun accès broker authentifié ou ordre réel/DEMO n’a été effectué.
