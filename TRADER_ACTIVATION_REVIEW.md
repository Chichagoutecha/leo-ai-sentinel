# Revue finale et dossier d’activation — BLOCKED

Date de revue : 3 novembre 2026 (UTC). Dépôt : `Chichagoutecha/leo-ai-sentinel`.

La PR #79 a été fusionnée à la demande de l’utilisateur. Base distante examinée : `main`, commit `8a1b838a9bcfc7a0ece01ba97b2c46e00d72719e`, arbre `c0b4aeeedbc1de90922bc881aed12c05b3d0e140`. Le checkout initial `5bcd104` avait exactement cet arbre ; le dossier est préparé sur `review/trader-activation-dossier`. Les PR #71, #72, #73, #74, #75, #76, #77, #78 et #79 sont effectivement fusionnées, vérification GitHub effectuée pendant cette revue. La CI de #79 était verte avant fusion ; cela ne prouve ni l’accès broker ni la rentabilité.

**Décision : BLOCKED. Aucune activation réelle proposée à approbation dans cet état.** Ce document prépare les correctifs et preuves nécessaires, pas une commande d’activation utilisable aujourd’hui.

## 1. Fonctionnalités vérifiées et limites de la répétition

| Brique intégrée | Preuve dans le dépôt et répétition | Ce que cette preuve ne valide pas |
| --- | --- | --- |
| Identité et jeton (#73) | `etoro-read-access-audit.js`, GET strictement autorisés, sélection non ambiguë, permissions séparées ; absence de clés testée sans requête | Identité réelle, lien du secret au jeton, droits d’écriture et attribution du PnL |
| Éligibilité (#74) | Client dédié au POST informatif exact, cache et contrôles compte/devise/sens/minimums, tests 401/403/429 | Éligibilité effective d’un instrument de ce compte ; aucune inscription automatique aux listes LEO |
| Observateur (#75) | Identité stable, lectures bornées, dates, états explicites, déduplication ; collecte injectée répétée ici | Transactions individuelles, unités et complétude publique non prouvées ; un 403 ne prouve pas une confidentialité |
| Expositions (#72/#76) | Positions propres/copies/observations/propositions séparées ; portefeuille, positions miroirs et attentes dédupliqués | Taxonomies, compositions, levier ou devises inconnus ne deviennent pas une diversification ; la complétude réelle reste à démontrer |
| Politique (#77) | Politique déterministe `trader-context-v1`, veto, historique de sélection, analyse propre de LEO obligatoire | Aucun classement « meilleurs traders » validé ; pas de copie de transactions ou consensus indépendant avec les sources actuelles |
| SHADOW (#71/#78) | Décisions gelées, deux bras, cash-flows, coûts séparés, benchmark, sorties/réductions virtuelles ; aucun exécuteur appelé | Évaluation réelle, alpha, prix exécutables ou risque de réplication d’un compte agent |
| Exécution (#79) | Pont utilisant les exécuteurs normaux, BUY/renfort/SELL complet, périmètre exact, réservation persistée, reprise sans renvoi automatique | Réduction réelle volontairement bloquée ; finalité de l’achat partiellement exécuté insuffisante (B4) |
| Journaux et reprise | Intention liée à la proposition, position exacte, ACK non suffisant, erreurs assainies, idempotence et persistance locale testées | Écrivain distribué unique, archivage durable complet et interrogation officielle de finalité d’ordre |

La répétition réutilisable est `node trader-activation-review.js` (ou `npm run review:trader-activation`). Elle n’importe pas `index.js`, ne charge aucun secret du processus et n’a aucun transport réseau réel. Le JSON de référence est `trader-activation-rehearsal.json` ; le test vérifie aussi sa reproductibilité. Les preuves REAL favorables de ses fixtures sont explicitement fictives et séparées des preuves virtuelles.

Elle traverse l’observateur normalisé, l’analyse des expositions et la politique dans l’expérience SHADOW, puis éprouve séparément le pont avec un adaptateur d’exécuteur normal simulé : achat, renfort et clôture, entrées désactivées avant la vente. Les tests existants du pont exécutent aussi les vrais corps des fonctions normales dans une VM avec transports remplacés. **Ce n’est pas une répétition de bout en bout du serveur et de tous les préchargements de `npm start`.** Cette preuve reste nécessaire avant activation (B6) ; elle doit se faire hors réseau avec transport unique instrumenté et faux stockage, sans démarrer de tâche de production.

Scénarios effectivement exécutés : cours perdu/périmé, coût inconnu, signal reçu dans le futur, source opposée, trader supposé devenu privé donnant 403 (retour `FORBIDDEN_PRIVACY_UNPROVEN`), dérive de prix, identité perdue, attentes inconnues, refus broker, erreur réseau, ACK seul, attribution ambiguë, redémarrage, réduction bloquée, clôture au-dessus du plafond et arrêt du pont. Les décisions passées restent inchangées ; aucune perte de visibilité ne provoque de liquidation automatique. Le scénario de remplissage partiel reproduit un défaut, il ne valide pas sa sécurité.

## 2. Accès et identités : preuves manquantes

Dans ce processus, seule la présence des variables a été vérifiée : `ETORO_API_KEY` et `ETORO_USER_KEY` absentes ; accès Upstash absent. Aucun environnement Render équipé des clés n’a été consulté. Le diagnostic isolé a effectué **0 requête authentifiée**, avec un transport volontairement bloqué. Aucune valeur de secret, empreinte de secret, identité personnelle, position ou solde réel n’est conservé dans ce dossier.

| Vérification réelle | État | HTTP | Correspondance |
| --- | --- | --- | --- |
| Identité authentifiée `/api/v1/me` | NOT_TESTED | Aucun appel | UNVERIFIED |
| Métadonnées `/api/v1/agent-portfolios` | NOT_TESTED | Aucun appel | UNVERIFIED |
| PnL `/api/v1/trading/info/real/pnl` | NOT_TESTED | Aucun appel | UNVERIFIED |
| Compte propriétaire ou agent ; environnement réellement interrogé | UNAVAILABLE | Aucun appel | UNVERIFIED |
| Secret chargé ↔ identifiant de jeton attendu | TOKEN_BINDING_UNVERIFIED | Aucun appel | UNVERIFIED |
| Éligibilité des instruments pour ce compte | NOT_TESTED | Aucun appel | UNVERIFIED |
| Droits d’ouverture, clôture et éventuelle réduction | NOT_TESTED | Aucun appel | UNVERIFIED |

Une lecture réussie ultérieure ne prouvera jamais un droit d’ordre. Distinguer le catalogue de permissions, les permissions d’un jeton sélectionné et les lectures réussies avec le secret chargé. Aucune agrégation entre jetons ; aucun choix du premier compte. Si l’API ne prouve pas le lien secret/jeton, conserver `TOKEN_BINDING_UNVERIFIED` et obtenir une attestation sécurisée de provisionnement avec provenance contrôlée ; ne remplacer aucun garde par une constante vraie.

Un solde virtuel agent ne représente pas le capital propriétaire ni les montants répliqués. Il faut une preuve datée du compte cible, de son environnement, des restrictions agent et des éventuels multiplicateurs de réplication. Les copies déjà existantes restent un périmètre distinct. Aucun appel de création/copie/ordre ne peut servir à vérifier un droit dans cette revue.

## 3. Résultats SHADOW et limites statistiques

**Résultats de production : UNAVAILABLE.** Durée, nombre réel de décisions, opérations clôturées, rendement, benchmark, recul maximal, volatilité, rotation, dépenses et couverture de production : inconnus. Les valeurs d’un état initial vide ne sont pas des mesures d’activité et ne sont pas présentées comme des zéros observés.

Le JSON contient uniquement deux décisions synthétiques sur 120 secondes de phase DESIGN, avec prix artificiels et qualification volontairement accélérée pour tester le raccordement. Il expose les deux bras et leurs mesures calculables ; il ne contient aucune période d’évaluation recevable. Ses frais et son glissement sont des hypothèses, pas des frais broker observés. Les appels d’observateur affichés sont simulés. Les dépenses réelles de collecte, IA et stockage ne sont pas mesurées ici.

Le protocole par défaut prévoit 30 jours de conception puis 90 jours d’évaluation ; exigences minimales déclarées : 60 jours d’évaluation, 100 décisions et 20 clôtures complètes par bras, sans retoucher la politique sur le même échantillon. Ces seuils sont des conditions opératoires configurables, pas une puissance statistique démontrée ni des optimums. Les données disponibles peuvent rendre ces seuils inatteignables : le runtime fournit encore `constraintsEvidence: null` et des coûts non liés au compte. Il faut d’abord raccorder ces preuves sans affaiblir les veto, puis recommencer une évaluation chronologique de la version exacte.

Mesures prévues par la comptabilité : dépôts/retraits séparés, coûts observés/estimés/inconnus, rendement Modified Dietz lorsque dates, flux et valorisations le permettent (approximation), rendement quotidien ajusté des flux, drawdown, volatilité, rotation et benchmark configurable dans la même devise si conversion fiable. Indiquer sinon la raison d’indisponibilité. Le benchmark de prix n’est pas nécessairement un rendement dividendes réinvestis. Valorisation partielle/périmée, FX manquant, frais inconnus, observations tardives et historique tronqué limitent les résultats.

La référence sans traders partage les mêmes idées LEO, fenêtres et contraintes ; elle n’est pas un second LEO autonome dont les décisions futures seraient recalculées avec son propre portefeuille. Un avantage causal ou une performance future ne peut être déduit de cette comparaison. La limite de rétention (120 enregistrements par défaut) exige un archivage chronologique pour conserver assez d’évidence sur la durée, plutôt que conclure sur un échantillon tronqué.

## 4. Défauts bloquants et limites non bloquantes

| ID | Blocage | Preuve / action nécessaire |
| --- | --- | --- |
| B1 | Compte, environnement, jeton et droits réels non établis | Clés absentes, 0 appel ; réaliser le diagnostic sécurisé et obtenir les preuves de provisionnement manquantes |
| B2 | Preuves financières et SHADOW de production absentes | `prepareTraderExecutionEvidence` garde `tokenBindingVerified: false`, `singleWriterVerified: false` ; adaptateurs coûts/éligibilité/sizing et approbation de release non alimentés ; ne pas contourner ces gardes |
| B3 | Aucune garantie d’écrivain unique ni arrêt global démontrés | Sérialisation locale seulement ; `/trader-execution-stop` n’arrête que le pont, pas les autres routes LEO/manuelles/préchargées ; ajouter un garde commun et une coordination durable |
| B4 | Finalité des achats partiels insuffisante | Répétition : demande fictive 10 USD au cours 10, apparition de 0,4 unité ; résultat normal simulé `confirmed: true`, pont `CONFIRMED`. La position est correctement quantifiée mais le reste de l’ordre n’est pas suivi. Il manque état terminal broker, engagement restant et réconciliation exacte de l’ordre ; bloquer tout nouvel envoi tant qu’ils sont inconnus |
| B5 | Sortie complète pouvant être impossible sous le plafond | `FULL_EXIT_EXCEEDS_ORDER_CAP_PARTIAL_CLOSE_UNSUPPORTED` reproduit ; valider une politique de plafond de clôture et de prise en charge opérateur avant une première entrée ; ne jamais remplacer silencieusement une réduction par une liquidation |
| B6 | Chaîne complète de démarrage non répétée | `npm start` précharge notamment compatibilité agent, pont UCITS et correctif ACK ; leurs wrappers HTTP doivent être éprouvés ensemble avec les gardes actuels et le blocage global, hors réseau |
| B7 | Conservation probante et fenêtre d’évaluation insuffisantes | Historique réel non consulté ; archivage, restauration et absence de troncature à prouver ; `ARCHIVE_REQUIRED_NO_AUTOMATIC_RESET` ne remplace pas une archive |

B4 est un contre-exemple du contrat normaliseur→pont, pas la preuve d’une réponse eToro réellement obtenue. Les champs de finalité à intégrer devront suivre le schéma officiel de consultation des ordres, sans inventer un statut ou endpoint. Aucun correctif d’exécution, droit ou contournement n’est appliqué dans cette revue.

Limites acceptables pour un premier périmètre explicitement restreint, après résolution des blocages : pas de réduction partielle, pas de levier/CFD/short, pas de classement comparatif fiable, pas de transactions publiques prouvées, pas de consensus supposé indépendant, pas de compositions inconnues utilisées pour dimensionner. La politique reste une information complémentaire à l’analyse propre de LEO. Les données absentes abaissent la confiance ou empêchent la proposition ; un refus de lecture n’est pas un signal vendeur.

## 5. Instruments et positions dans le périmètre

**Actuellement, aucun instrument ni aucune position n’est autorisé par cette revue pour une exécution stratégique réelle.** Les listes effectives de production, positions et registre géré n’ont pas été lus. Une présence dans WATCHLIST ou une éligibilité technique ne crée pas une permission LEO.

Pour un éventuel pilote ultérieur, sélectionner un seul instrument déjà présent dans la WATCHLIST **et déjà autorisé** par la politique effective, après éligibilité compte/devise/minimum vérifiée. Exemple de candidat technique existant : `MSFT`, instrument `8757` dans le code examiné ; cela n’est ni une recommandation d’investissement ni une autorisation de l’ajouter aux listes. Revalider identité instrument/produit, règlement Underlying, LONG, levier 1 et USD. Si le minimum ou le coût dépasse les plafonds, ne pas ouvrir le pilote. Ne pas substituer un ETF/CFD ou composants de Smart Portfolio pour contourner cette incompatibilité.

Seules de nouvelles positions issues d’intentions de cette stratégie, attribuées sans ambiguïté et enregistrées comme `VERIFIED_MANAGED`, pourraient être gérées. Les unités/positionId doivent correspondre exactement au portefeuille récent. Positions personnelles, anciens achats LEO, copies natives, positions non identifiées ou modifiées manuellement : exclues et non adoptées automatiquement. Plusieurs signaux sur un même positionId restent une seule position broker, sans lots par trader. Au départ, exclure aussi les renforcements pour simplifier l’attribution et vérifier un aller-retour complet.

CopyTrader natif et Smart Portfolios ne sont pas activés par ce pilote. Leurs portefeuilles observés ne deviennent jamais notre exposition détenue ; leur activation exigerait une étude et une instruction distinctes.

## 6. Plafonds proposés pour une étape ultérieure

Ces plafonds de maîtrise du risque opérationnel sont des propositions conservatrices à confirmer selon capital, coûts, minimums et périmètre de compte. Aucun réglage n’a été appliqué et aucun seuil n’est présenté comme optimal.

| Paramètre | Proposition initiale | Justification / condition |
| --- | --- | --- |
| Univers / positions | 1 instrument, 1 position stratégique, pas de renfort | Vérifier d’abord attribution, maintien puis sortie complète |
| Achat | au plus `min(5 USD, 1 % des fonds propres vérifiés)` ; plafond absolu existant 10 USD conservé | Limiter l’engagement ; minimum incompatible ⇒ pilote bloqué, jamais augmenter automatiquement |
| Cadence | au plus 1 nouvelle entrée / 24 h ; réserver la capacité d’une sortie | Le plafond global existant est 4 opérations/24 h, 3 achats, 2 ventes, intervalle 2 h ; une sortie peut être retardée : ce comportement doit être accepté ou corrigé séparément avant pilote |
| Espèces | au moins 20 % des fonds propres et la réserve absolue normale si supérieure | Cash et fonds propres du bon compte, frais et attentes déduits, aucune assimilation au capital propriétaire |
| Concentration | plafond pilote 10 % des fonds propres pour l’instrument, ou limite existante plus stricte | Inclure détentions propres, copies et attentes ; exposition inconnue ⇒ entrée bloquée |
| Coûts | devis complet lié au compte/sens/taille ; limite relative 1 % et plafond USD approuvé avant pilote | 1 % de 5 USD = 0,05 USD : si le coût est supérieur/inconnu, ne pas négocier ; le plafond runtime nul n’est pas relevé ici |
| Prix / fraîcheur | conserver au maximum la dérive de 2 % et les fenêtres strictes actuelles ; jamais les élargir pour rendre un test vert | Dates de cours, réception et preuves vérifiées à chaque frontière d’envoi |
| Sorties | clôture exacte seulement, budget de clôture distinct, approuvé avant entrée pour l’exposition maximale stressée | Ne pas réutiliser aveuglément le plafond d’achat ; absence de valeur sûre compatible avec les contrôles ⇒ B5 non levé |

Les limites pilote (1 %/10 %, 1 entrée par jour) ne disposent pas toutes aujourd’hui d’un interrupteur autonome dans le runtime : elles nécessitent une politique versionnée et des tests, pas de variables d’environnement inventées. Il faut décider explicitement du traitement d’une sortie de protection lorsque cadence, coût, perte de visibilité ou plafond de clôture bloquent : suspension et escalade opérateur, aucun dépassement implicite. Cette décision doit être testée sans broker.

## 7. Suspension, arrêt et positions déjà ouvertes

| Action | Effet voulu | Positions existantes / limites actuelles |
| --- | --- | --- |
| Désactiver les nouvelles entrées | Désactiver les BUY stratégiques et renforts ; conserver lecture et sorties autorisées | `entriesEnabled: false` est séparé des SELL ; cela n’interdit pas les achats d’autres parcours LEO |
| Suspendre toute exécution | Interdire tout nouvel appel d’exécution de tous les parcours concernés ; conserver lecture, preuves et réconciliation | Le stop actuel ne couvre que le pont : B3 impose le garde global. Un ordre déjà transmis n’est ni annulé ni réputé rejeté ; conserver `NEEDS_RECONCILIATION` sans renvoi |
| Demander une liquidation | Nouvelle décision explicite de clôture, instrument/positionId/quantité et périmètre détaillés, après contrôle | Aucun stop ne liquide. Aucun droit implicite sur les positions personnelles/copies. Marché fermé, plafond, minimum ou incertitude peuvent empêcher la clôture ; demander une nouvelle instruction sur un résultat concret |

Procédure opératoire proposée :

1. Désactiver d’abord les nouvelles entrées en cas de dérive ; si identité/jeton incertains, échec de persistance, écrivains concurrents, unités contradictoires ou ordre incertain, suspendre tous les envois concernés. Activer le stop durable du pont, puis le garde global une fois implémenté. Ne pas utiliser un simple redémarrage comme remise à zéro.
2. Conserver un inventaire assaini des intentions et positions gérées ; consulter uniquement les lectures officielles nécessaires à la finalité. Ni renvoi, ni annulation, ni liquidation automatiques lors de cette tâche ou d’une reprise incertaine.
3. Les positions ouvertes restent au marché sous leurs protections broker déjà existantes ; l’arrêt logiciel ne crée ni stop-loss ni protection nouvelle. Documenter le risque restant et transférer la surveillance à l’opérateur. Une position partiellement remplie reste incluse à sa quantité réelle avec engagement résiduel inconnu réservé.
4. Si l’utilisateur demande ensuite de liquider, préparer une liste précise de positions gérées et de contrôles, sans étendre le périmètre. Réconcilier chaque résultat ; ne considérer ni ACK ni absence temporaire d’une page comme preuve suffisante.
5. Reprise seulement après revue du stockage restauré, contexte compte/jeton identique, écrivain unique, ordres résolus et approbation explicite de la version et du registre. Pas de reset automatique des tombstones ni d’adoption des lignes non gérées.

Surveillance à prévoir symétriquement pour BUY et SELL : proposition, veto, ordre/intention, accusé, quantité exécutée, reste engagé, statut terminal, frais/cash et position après opération ; alerte sur retard de confirmation, sortie empêchée, absence de données, stockages/quota proches des limites. Perte d’un trader : suspendre ses entrées, réexaminer les sorties avec l’analyse propre de LEO, ne pas liquider par mimétisme. Des achats et ventes opposés ou corrections tardives ne réécrivent jamais une décision antérieure.

## 8. Changements exacts nécessaires avant une activation ultérieure

Ordre de réalisation, sans changement Render/LIVE aujourd’hui :

1. **Code :** traiter B4 dans le vérificateur normal, la normalisation des réponses, le registre des intentions et `trader-execution-bridge.js` : état de remplissage partiel, montant/unités exécutés, engagement restant, ordre terminal lié à l’intention et au compte. Réconcilier via lectures officielles, sans renvoi automatique. Ajouter achat partiel puis complément tardif, rejet du reste, disparition de lecture, partial SELL involontaire et redémarrage. Rester conservateur lorsque l’API ne permet pas cette preuve.
2. **Code :** garde d’arrêt commun à toutes les frontières d’envoi, couvrant chemins normaux, manuels et préchargements ; coordination d’écrivain unique avec fencing durable et échec fermé. Prouver arrêt pendant réservation, requête en vol, redémarrage et deux processus concurrents. Ne pas confondre ce garde avec l’autorisation de liquider.
3. **Code et données :** alimenter les adaptateurs `traderAdvisoryCostEvidence`, `traderAdvisoryEligibilityEvidence`, `traderExecutionSizingEvidence` et coûts d’exécution liés à la proposition ; contraintes virtuelles distinctes pour l’expérience. Sources réelles datées, compte et jeton, couverture des attentes et compositions ; valeurs inconnues refusées. Geler les plafonds pilote et le plafond SELL approuvé ; aucun nouvel actif ajouté automatiquement.
4. **Preuves sécurisées :** faire le diagnostic de lecture dans l’environnement équipé, conserver uniquement correspondances et états assainis. Établir compte, environnement, jeton, droits, éligibilité et limitations agent. Ne pas créer de jeton ni tester un ordre. Réconcilier l’historique avant toute initialisation du registre via `initializeForContext` ; aucune route d’initialisation publique n’existe.
5. **SHADOW :** archiver puis exécuter le protocole gelé avec données reçues à la date, deux bras, BUY et SELL, coûts d’observation et période d’évaluation distincte. Une nouvelle politique/configuration exige une nouvelle évaluation. Soumettre durée, échantillon, clôtures, couverture, limites et défauts à revue ; ne pas fabriquer `releaseApproval` depuis un test vert.
6. **Répétition et approbation :** rejouer hors réseau le démarrage complet et tous les scénarios de ce dossier, restaurer une sauvegarde, prouver les plafonds, la surveillance et l’arrêt global. Obtenir ensuite une instruction explicite sur le compte/politique/instrument/position/caps/version évalués. L’état doit alors porter une approbation contrôlée pour cette seule release, des preuves de binding et d’écrivain unique réelles ; retirer les constantes non vérifiées uniquement au profit de preuves validées.
7. **Configuration future, uniquement après cette instruction :** examiner les valeurs actuelles avant toute modification. `TRADING_MODE` devrait devenir `LIVE`, `LIVE_EXECUTION_ARMED` être explicitement armé et `LIVE_BUY_CONFIRMATION` satisfaire le contrat existant ; `TRADER_EXECUTION_ENABLED`, `TRADER_EXECUTION_ENTRIES_ENABLED`, `TRADER_EXECUTION_EXITS_ENABLED` seraient autorisés séparément. La confirmation stratégique exacte attendue est `I_UNDERSTAND_TRADER_STRATEGY_REAL_ORDERS`. `TRADER_EXECUTION_MAX_COST_USD` et `TRADER_EXECUTION_MAX_EXIT_NOTIONAL_USD` prendraient les plafonds alors approuvés ; aucun montant sûr ne peut être fixé sans preuves B1/B5. `TRADER_EXECUTION_EMERGENCY_STOP` resterait armé pendant la vérification préalable puis ne pourrait être retiré qu’après validation de l’arrêt global et des intentions. Les listes d’autorisation restent inchangées ; instrument absent ⇒ pas de pilote. Cette liste est un inventaire de changements futurs, pas une commande à exécuter.

Progression après levée des blocages : SHADOW observé et revu → répétition intégrale avec mode et armements simulés → pilote réel explicitement autorisé à une position/une entrée puis sortie complète surveillées → pause et revue de tous les résultats et coûts → élargissement éventuel par nouvelle instruction et nouveau périmètre. La surveillance passive seule ne prouve pas les droits d’ordre. Aucun essai réel ou DEMO, même « petit », n’est inclus dans ce dossier.

## Sources officielles consultées et vérifications

Documentation officielle relue le 3 novembre 2026, sans appel aux endpoints broker :

- [Éligibilité informative](https://api-portal.etoro.com/api-reference/trading--real/check-instrument-trading-eligibility) : endpoint dédié, distinct des ordres.
- [Métadonnées des portefeuilles agents](https://api-portal.etoro.com/api-reference/agent-portfolios/get-agent-portfolios) : ne suffit pas à lier le secret chargé à un jeton.
- [Consultation d’ordre et détails de positions](https://api-portal.etoro.com/api-reference/trading--real/get-order-information-and-position-details) : `GET /api/v2/trading/info/orders:lookup`, exactement un de `orderId` ou `referenceId`, état d’ordre et exécutions. Le schéma documente notamment `status`, `requestedAmount` et `positionExecutions` ; la présence d’une position seule n’établit pas la fin de l’ordre. Aucun appel effectué, intégration complémentaire à valider.
- [Clôture par unités](https://api-portal.etoro.com/api-reference/trading--real/close-position-by-units) : existence d’une opération documentée ne prouve ni prise en charge fiable de la réduction dans LEO ni autorisation du compte.

Résultats réellement obtenus sur cette branche :

- `npm ci --ignore-scripts --no-audit --no-fund` : réussi ; 91 dépendances installées, aucun serveur lancé.
- `npm run check` : réussi ; les quatre fichiers JavaScript ajoutés sont inclus dans la syntaxe vérifiée.
- `npm test` : **307/307**, zéro échec. Deux tests de revue supplémentaires, dont un contre-exemple utilisant le véritable `evaluateExecutionEvidence` extrait de `index.js` en VM, puis la réconciliation du pont. Il reproduit B4 sans réseau.
- Répétition : **21 scénarios**, dont **2 `BLOCKER_REPRODUCED`** ; **0 appel réseau réel**, comparaison reproductible du JSON réussie. Ils ne sont pas 21 preuves d’activation.
- `test:ai-preload`, `test:ai-context-preload`, `test:production-preflight`, `test:ai-cost-concurrency`, `test:ai-cost-missing-usage` : réussis ; les quatre suites de tests comptent chacune 1/1, le préflight termine avec code 0. Ces tests ne constituent pas la répétition intégrale du serveur demandée par B6.
- Treize blocs d’invariants statiques du workflow : réussis localement, en conservant les assertions et en comparant à la base locale de même arbre ; les appels de test déjà effectués et le fetch distant ont été omis de cette répétition statique.
- `git diff --check` : réussi ; `index.js`, `trader-execution-bridge.js`, `trade-universe-policy.js`, `package-lock.json` et la commande start inchangés.

Les fixtures accélérées ne changent pas les règles LIVE et leurs assertions de défauts connus doivent être révisées lorsque ces défauts sont corrigés ; un test vert du contre-exemple n’est pas un feu vert de trading. Le résultat de la CI distante de la nouvelle PR devra être consulté séparément ; il ne peut pas lever les blocages de données ou d’exécution décrits ici.

## Fichiers de cette revue

- `TRADER_ACTIVATION_REVIEW.md` : dossier et décision.
- `trader-activation-review.js` : répétition déterministe hors réseau.
- `activation-review-fixtures.js`, `activation-shadow-fixture.js` : comptes, réponses et preuves purement synthétiques.
- `trader-activation-rehearsal.json` : résultat reproductible assaini, explicitement virtuel.
- `test-trader-activation-review.js` : absence de réseau, reproductibilité et défauts reproduits.
- `package.json` : commande de revue, vérification syntaxique et test intégrés.
- `.github/workflows/quality-clean-etoro-v2-production-rc.yml` : chemins exacts de ces fichiers ajoutés aux contrôles existants.

Aucune logique d’exécution de production, autorisation LIVE, liste d’actifs, commande de démarrage ou configuration Render/déploiement n’est modifiée. Aucun ordre REAL/DEMO, copie, création de jeton ou déploiement effectué.

**BLOCKED**
