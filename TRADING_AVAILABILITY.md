# Disponibilité du trading et portée des veto

## Base réellement examinée

Revue du 3 novembre 2026. `main` distant : `21647491d645c20966c50a698df39cb4bccaf836`, après fusion effective de #80. Les cinq PR récentes #76 à #80 sont fermées et fusionnées. Le checkout initial `review/trader-activation-dossier`, commit `93390ce`, a le même arbre `a122fbe6c1eb7d558369d776e16d4bde3168caf1` que la base distante. Travail isolé sur `feat/scoped-trading-vetoes`. Aucun résultat de production ni droit broker nouvellement vérifié.

Fichiers examinés : dossier `TRADER_ACTIVATION_REVIEW.md`, exécuteurs normaux et préflight REAL, `riskController`, scan, politique consultative, pont traders, politique d’achat, comptabilité SHADOW et commande start avec ses préchargements. Le dossier d’activation précédent reste une photographie datée ; ses blocages de compte/jeton, finalité d’achats partiels, stockage/écrivain unique et plafond de clôture restent ouverts.

## Changements effectifs

1. **Clôture stratégique exacte :** une position directe, LONG, levier 1, Underlying, déjà `VERIFIED_MANAGED`, peut fournir une proposition SELL à partir de l’analyse propre approuvée de LEO, avec les références historiques de ses sources. La visibilité actuelle des traders n’est plus un préalable à cette proposition. Ces références ne deviennent ni des transactions observées ni une preuve de qualité actuelle. Aucun nouveau trader ou actif n’est sélectionné.
2. **Préflight SELL :** cash d’entrée, minimum d’ouverture, permission BUY, diversification agrégée et contexte social ne sont pas des conditions de cette clôture exacte. L’identité, le compte/jeton, la release, le portefeuille frais et cohérent, les attentes, l’éligibilité CLOSE, les coûts, le prix/dérive, la cadence, le plafond SELL et l’approbation de risque demeurent obligatoires. Une donnée globale inconnue reste inconnue ; elle n’est pas convertie en zéro. Seule la suppression de la quantité longue identifiée est établie, sans promettre une baisse de tout risque net ou de couverture du compte.
3. **Positions voisines :** une position personnelle ou copiée sur le même instrument ne bloque plus la clôture de la position gérée exacte. Elle ne peut pas être adoptée ou ciblée à sa place. BUY et renfort restent bloqués si un mélange de périmètres sur cet instrument est possible.
4. **Panne de la couche traders :** une exception de l’évaluation cache-only est assainie et isolée. Elle n’interrompt plus automatiquement une sortie indépendante normale déjà approuvée. Les exceptions du dispatch ne sont jamais transformées en « aucun envoi » et ne déclenchent aucun fallback ou renvoi.
5. **Pas de fallback sur une mauvaise position :** lorsqu’une sortie gérée est proposée, rejetée ou impossible à construire, le scan ne retombe pas sur une clôture normale qui choisirait une autre ligne par symbole. Une exception d’évaluation avec un périmètre géré identifié reste également circonscrite à ce périmètre.
6. **Diagnostic :** codes stables ajoutés aux HOLD normaux, `vetoDetails` aux refus REAL et au pont, `blockerDetails` à la politique d’achat. Le statut authentifié du pont expose ces métadonnées. Les codes et textes historiques restent disponibles ; les motifs génériques HOLD sont précisés par des codes stables. Aucun motif n’autorise un ordre.

Le module `trading-availability.js` est déterministe, sans réseau, secret, ordonnanceur ou état d’armement. Il décrit cause, portée, actions bloquées, autres actions/cibles réévaluables, résolution possible et nécessité de revue. `automaticResolutionPossible` signifie qu’une nouvelle lecture ou l’expiration d’une fenêtre peut apporter de nouvelles preuves : ce n’est pas un mécanisme de reprise. `automaticOrderRetryAllowed` et `executionPermissionGranted` restent toujours faux. Un code inconnu reçoit une portée compte conservatrice et une revue obligatoire, sans recopier son texte potentiellement sensible. Le registre du pont conserve seulement les codes et les notes compactes ; le détail est reconstruit à la lecture afin de ne pas accélérer inutilement son arrêt pour limite de stockage.

## Données indispensables selon l’action

| Action | Données et contrôles conservés | Données qui ne suffisent pas à interdire seules |
| --- | --- | --- |
| Entrée / renfort stratégique | Armements, release, identité compte/jeton, écrivain unique, stockage, portefeuille/attentes cohérents, instrument autorisé, cours, éligibilité OPEN, montant/minimum, coûts liés à la taille, cash/réserve, exposition marginale, propre analyse de risque, contexte trader actuel | Benchmark de performance absent ; données d’un autre instrument sans incohérence globale |
| Clôture complète stratégique | Contrôles communs de sécurité, positionId géré exact, propriété directe, LONG/Underlying/levier 1, unités réelles égales aux unités gérées, éligibilité CLOSE, coût lié aux unités, risque propre approuvé, cours frais, plafond de clôture, absence d’intention incertaine | Cash disponible pour acheter, minimum OPEN, activation BUY, visibilité des sources historiques, classification sectorielle globale incomplète |
| Réduction partielle réelle | **Toujours interdite** : `PARTIAL_CLOSE_NOT_RELIABLY_SUPPORTED` | Jamais remplacée par une liquidation ou une vente à découvert |
| Analyse indépendante normale | Sources et approbations du parcours LEO normal | Observateur de traders indisponible ; benchmark analytique absent |

Les positions et ordres réellement inconnus, une attribution de compte douteuse ou un portefeuille structurellement incomplet restent un veto partagé. La séparation des couches ne permet pas de contourner une réserve inconnue, des montants engagés inconnus ou une position manquante. Les limites de cadence globales restent inchangées, y compris pour SELL ; aucun budget de sortie nouveau n’est créé dans cette tâche.

Le benchmark n’était pas un préalable direct dans `riskController` et le pont : aucun garde n’a été supprimé pour lui. La couverture du scorecard SHADOW dépend des flux, risques et valorisations ; l’indisponibilité du seul benchmark laisse sa comparaison indisponible. Les veto de valorisation du portefeuille ou de pertes mesurées restent en place. Les tests avec benchmark absent et observateur non consultable vérifient des approbations normales sous contraintes simulées complètes.

## Inventaire des frontières et résolution

| Frontière existante | Cause / portée | Résolution et comportement conservé |
| --- | --- | --- |
| Mode OFF/SHADOW/DEMO et armements LIVE | Contexte d’exécution et sens autorisés | Configuration explicite seulement ; aucun armement ajouté ici. SHADOW reste strictement virtuel |
| Préflight REAL | Portefeuille invalide, compte/jeton ou environnement incohérent : compte entier | Rétablir les preuves et réconcilier ; aucune adoption d’identité configurée comme preuve |
| Préflight BUY | Position/ordre sur l’actif, montant/minimum/copied-capital, cash et allocation | Revoir l’entrée pour cet instrument ; les exigences d’ouverture ne sont pas déplacées vers SELL |
| Intention active / incertaine | Compte entier dans le risque normal et le pont ; protection supplémentaire par instrument dans l’exécuteur | Lecture et réconciliation conservées ; jamais de renvoi automatique ni d’expiration aveugle |
| Cours, intégrité / consensus | Instrument | Rafraîchir et réévaluer ; divergences et prix inexécutables restent bloquants pour BUY et SELL |
| Technique, intelligence, macro, conseil, revue SELL | Décision / instrument | Leurs prédicats existants et modes required/enforced sont conservés. La macro d’entrée ne bloque déjà pas seule un SELL. Une absence d’analyse SELL exigée n’est pas transformée en approbation |
| Circuit santé, stockage, cadence, plafonds | Compte / processus ou sens concerné | Rétablissement contrôlé ; contraintes communes non relâchées. Le verrou distribué reste à implémenter |
| Sélection des traders / proposition consultative | Stratégie et instrument, pas autorité du compte | BUY stratégique exige encore une source actuelle et sélectionnée ; SELL géré utilise provenance historique et nouvelle analyse LEO, puis toutes les protections d’exécution |
| Exécution normale BUY/SELL | Instrument, montant, target, intent puis preuve d’effet | Corps HTTP, ciblage exact et contrôles normaux conservés. ACK seul ne donne pas de droit à un renvoi. Le défaut de finalité des achats partiels de #80 reste ouvert |
| Pont UCITS préchargé | Mapping ETF BUY, approbation du substitut, marché, identité exacte, cours, spread | `UCITS_EXECUTION_GUARD_ACTIVE`, `UCITS_SYMBOL_NOT_APPROVED`, `UCITS_EXECUTION_VENUE_CLOSED`, `UCITS_SYMBOL_SEARCH_HTTP_ERROR`, `UCITS_SYMBOL_EXACT_MATCH_REQUIRED`, `UCITS_QUOTE_HTTP_ERROR`, `UCITS_QUOTE_NOT_FOUND`, `UCITS_QUOTE_TIMESTAMP_REQUIRED`, `UCITS_QUOTE_STALE`, `UCITS_SPREAD_TOO_WIDE` : restent locaux au mapping/achat ; aucune permission UCITS ou substitution activée |
| Compatibilité agent préchargée | Jeton attendu absent/introuvable, scopes du jeton sélectionné | `EXPECTED_TOKEN_ID_REQUIRED` / `EXPECTED_TOKEN_NOT_FOUND` restent fermés en LIVE armé ; les métadonnées ne prouvent toujours pas à elles seules le lien secret/jeton |
| Correctif ACK/no-effect préchargé | Réponse vide/ACK sans effet, ou rejet UCITS prouvé avant envoi | Conditions existantes de réconciliation et preuves de non-envoi conservées ; aucun reset ou renvoi ajouté |
| Optimiseurs IA et préflight IA | Budget, usage, cache, schéma/modèle et configuration de démarrage | Un refus de production valide reste un refus ; aucun budget ni contrat de préchargement changé |
| Observateurs Execution Quality / All-In Cost / Hold Opportunity | Mesures SHADOW non décisionnelles | Leurs déclarations `canPlaceOrder:false` / `canBlockOrder:false` restent en place ; aucune mesure manquante convertie en veto d’ordre supplémentaire |

L’inventaire ci-dessous couvre chacun des codes de veto du pont, des HOLD du contrôleur normal, des refus du préflight REAL et de la politique d’achat. Les tests vérifient les codes du pont et du contrôleur pour éviter un code introduit sans classification. Les sous-raisons dynamiques de technique/conseil/préflight restent sous leur code parent et leur validation existante ; elles ne sont pas réinterprétées à partir du texte libre. Les garde-fous de préchargement sont inventoriés ci-dessus et ne sont pas réécrits.

## Limites et vérification

Les analyses indépendantes ne sont pas remplacées par des achats automatiques de secours quand la stratégie est activée : une panne de ses sources ne devient pas une permission d’achat via un autre parcours. Les routes manuelles préexistantes et leurs armements ne sont pas élargis. La proposition de clôture gérée n’est pas un nouvel ordre de trader : elle exige une propre décision SELL de LEO et une release approuvée, jamais la simple disparition du portefeuille d’une source.

Le changement prépare le comportement mais ne rend pas le compte prêt : lien jeton/compte et écrivain unique restent non vérifiés dans le runtime, éligibilité/coûts réels non alimentés, release non approuvée, registre initial en recoveryRequired. Les scénarios de finalité partielle et de plafond de sortie du dossier #80 restent bloquants. Aucun test vert ne démontre un accès broker ou une rentabilité. Aucune commande start du serveur principal exécutée.

Résultats réellement obtenus sur cette branche :

- `npm ci --ignore-scripts --no-audit --no-fund` : réussi, 91 dépendances installées.
- `npm run test:availability` : **12/12**, avec clients et preuves simulés ; aucune requête réelle.
- `npm run check` et `npm test` : réussis ; **319/319**, zéro échec.
- `test:ai-preload`, `test:ai-context-preload`, `test:production-preflight`, `test:ai-cost-concurrency`, `test:ai-cost-missing-usage` : réussis. Les quatre suites comportent chacune 1 test réussi ; le préflight retourne code 0.
- Treize blocs d’invariants statiques du workflow : réussis localement en comparant à `93390ce`, de même arbre que la base distante ; fetch distant et répétitions de tests déjà exécutés omis de cette vérification statique.
- `git diff --check` : réussi. Commande start, constantes de cadence/armement, plafonds, listes autorisées, préchargements, payloads d’ordres et `package-lock.json` inchangés.

Les tests couvrent panne isolée, benchmark manquant, BUY indépendant, SELL sans achat, entrée refusée mais clôture admissible, veto local non propagé à un autre instrument, compte incohérent, attentes inconnues, copie/position personnelle voisine, cible/levier/quantité contradictoires, provenance historique, erreur d’évaluation versus erreur de dispatch et structure des motifs. Les tests existants couvrent toujours persistance, redémarrage et absence d’appels d’exécution en SHADOW. Ils ne constituent pas une répétition complète du serveur et de ses préchargements avec un compte réel.

Fichiers modifiés : `index.js`, `trader-execution-bridge.js`, `trade-universe-policy.js`, `trading-availability.js`, `test-trading-availability.js`, `package.json`, `.github/workflows/quality-clean-etoro-v2-production-rc.yml` et ce document. Le workflow accepte exactement ces nouveaux fichiers de tests/inventaire, sans retirer d’assertion existante. La CI distante de la nouvelle PR doit être consultée séparément.

Aucun ordre REAL/DEMO, appel broker, activation LIVE, secret ajouté, modification Render, copie native ou déploiement. Les autorisations effectives restent à vérifier dans l’environnement équipé ; cette PR ne vaut pas activation du compte.

## Catalogue des motifs structurés

`ENTRY` et `REINFORCEMENT` concernent les ouvertures ; `REDUCTION` et `CLOSE` concernent les sorties. « Résolution possible » n’implique jamais un renvoi d’ordre. La cible exacte est portée par `vetoDetails.target` lorsqu’elle est connue.

| Cause | Portée | Actions bloquées | Résolution | Nouvelle preuve automatique possible |
| --- | --- | --- | --- | --- |
| ACCOUNT_OR_TOKEN_BINDING_UNVERIFIED | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_AND_REVIEW_ACCOUNT_STATE_NO_RESEND | Non : revue |
| AGGREGATE_EXPOSURE_NOT_REQUIRED_FOR_EXACT_CLOSE | ANALYTICS | Aucune : information | DIAGNOSTIC_ONLY_NOT_AN_EXECUTION_PERMISSION | Oui, sans renvoi |
| AI_RISK_VETO | DECISION | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_REQUIRED_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| ALLOCATION_ENTRY_VETO | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| AMOUNT_OUTSIDE_CAP_OR_MINIMUMS | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| ASSET_CATEGORY_NOT_ALLOWLISTED | INSTRUMENT | ENTRY, REINFORCEMENT | VERIFY_EXISTING_INSTRUMENT_AUTHORIZATION | Non : revue |
| ASSET_CATEGORY_NOT_TRADEABLE | INSTRUMENT | ENTRY, REINFORCEMENT | VERIFY_EXISTING_INSTRUMENT_AUTHORIZATION | Non : revue |
| ASSET_COOLDOWN | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| ASSET_NOT_ALLOWLISTED | INSTRUMENT | ENTRY, REINFORCEMENT | VERIFY_EXISTING_INSTRUMENT_AUTHORIZATION | Non : revue |
| AUTOMATION_DISABLED | STRATEGY | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | EXPLICIT_CONFIGURATION_OR_RELEASE_REVIEW | Non : revue |
| AVAILABLE_CASH_OR_RESERVE_INSUFFICIENT | ACCOUNT | ENTRY, REINFORCEMENT | RESTORE_CASH_AND_RESERVE_EVIDENCE | Oui, sans renvoi |
| BELOW_MIN_ORDER_AFTER_RISK_SCALING | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| BENCHMARK_ANALYTICS_ONLY | ANALYTICS | Aucune : information | DIAGNOSTIC_ONLY_NOT_AN_EXECUTION_PERMISSION | Oui, sans renvoi |
| BUY_CONFIDENCE_VETO | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| BUY_DAILY_LIMIT | ACCOUNT | ENTRY, REINFORCEMENT | WAIT_FOR_EXISTING_LIMIT_WINDOW | Oui, sans renvoi |
| BUY_SIZE_EVIDENCE_MISMATCH | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| CADENCE_RISK_OR_SINGLE_WRITER_UNVERIFIED | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | VERIFY_SINGLE_WRITER_AND_LIMITS | Non : revue |
| CASH_OR_RESERVE_UNAVAILABLE | ACCOUNT | ENTRY, REINFORCEMENT | RESTORE_CASH_AND_RESERVE_EVIDENCE | Oui, sans renvoi |
| CONCENTRATION_ENTRY_VETO | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| COPY_SIZING_UNVERIFIED | ACCOUNT | ENTRY, REINFORCEMENT | VERIFY_REAL_COPIED_CAPITAL_CONFIGURATION | Non : revue |
| COST_UNKNOWN_OR_EXCESS | DECISION | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_REQUIRED_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| COUNCIL_VETO | DECISION | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_REQUIRED_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| DATA_INTEGRITY_VETO | INSTRUMENT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | REFRESH_AND_REEVALUATE_NEW_DECISION_NO_RESEND | Oui, sans renvoi |
| DEMO_ACCOUNT_NOT_EXPLICITLY_ARMED | ACCOUNT | ENTRY, REINFORCEMENT | EXPLICIT_MODE_ACCOUNT_AND_ARMING_REVIEW | Non : revue |
| DUPLICATE_OR_PENDING_ORDER | ACCOUNT | ENTRY, REINFORCEMENT | RECONCILE_EXISTING_ORDER_NO_RESEND | Non : revue |
| DUPLICATE_POSITION_IDENTIFIERS | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_AND_REVIEW_ACCOUNT_STATE_NO_RESEND | Non : revue |
| ELIGIBILITY_UNVERIFIED | DECISION | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_REQUIRED_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| EMERGENCY_STOP | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_AND_REVIEW_ACCOUNT_STATE_NO_RESEND | Non : revue |
| ENTRIES_DISABLED_OR_BUY_ARMING_REQUIRED | STRATEGY | ENTRY, REINFORCEMENT | EXPLICIT_CONFIGURATION_OR_RELEASE_REVIEW | Non : revue |
| EVALUATION_RELEASE_UNVERIFIED | STRATEGY | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | EXPLICIT_CONFIGURATION_OR_RELEASE_REVIEW | Non : revue |
| EXACT_MANAGED_FULL_POSITION_SCOPE_UNVERIFIED | POSITION | REDUCTION, CLOSE | VERIFY_EXACT_POSITION_AND_SUPPORTED_CLOSE_POLICY | Non : revue |
| EXECUTION_COOLDOWN | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | WAIT_FOR_EXISTING_LIMIT_WINDOW | Oui, sans renvoi |
| EXECUTION_MODE_NOT_ORDER_CAPABLE | ACCOUNT | ENTRY, REINFORCEMENT | EXPLICIT_MODE_ACCOUNT_AND_ARMING_REVIEW | Non : revue |
| EXISTING_ORDER | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| EXISTING_POSITION | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| EXITS_DISABLED | STRATEGY | REDUCTION, CLOSE | EXPLICIT_CONFIGURATION_OR_RELEASE_REVIEW | Non : revue |
| FINAL_ALLOCATION_RECHECK_FAILED | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| FINAL_LEO_RISK_VETO_OR_UNVERIFIED | DECISION | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_REQUIRED_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| FRESH_QUOTE_REQUIRED | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| FULL_EXIT_EXCEEDS_ORDER_CAP_PARTIAL_CLOSE_UNSUPPORTED | POSITION | REDUCTION, CLOSE | VERIFY_EXACT_POSITION_AND_SUPPORTED_CLOSE_POLICY | Non : revue |
| GLOBAL_ORDER_LIMIT | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | WAIT_FOR_EXISTING_LIMIT_WINDOW | Oui, sans renvoi |
| HEALTH_CIRCUIT_OPEN | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_AND_REVIEW_ACCOUNT_STATE_NO_RESEND | Non : revue |
| HOLD_CHOSEN | DECISION | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | WAIT_FOR_NEW_DECISION | Oui, sans renvoi |
| INSTRUMENT_NOT_ALLOWED | INSTRUMENT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | VERIFY_INSTRUMENT_AND_EXISTING_AUTHORIZATION | Non : revue |
| INSTRUMENT_OR_ALLOWLIST_UNVERIFIED | INSTRUMENT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | VERIFY_INSTRUMENT_AND_EXISTING_AUTHORIZATION | Non : revue |
| INSTRUMENT_UNKNOWN | INSTRUMENT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | VERIFY_INSTRUMENT_AND_EXISTING_AUTHORIZATION | Non : revue |
| INTELLIGENCE_VETO | DECISION | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_REQUIRED_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| INVALID_DECISION | DECISION | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_REQUIRED_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| LIVE_BUY_NOT_EXPLICITLY_ARMED | ACCOUNT | ENTRY, REINFORCEMENT | EXPLICIT_MODE_ACCOUNT_AND_ARMING_REVIEW | Non : revue |
| LIVE_MODE_AND_ARMING_REQUIRED | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_AND_REVIEW_ACCOUNT_STATE_NO_RESEND | Non : revue |
| MACRO_ENTRY_VETO | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| MARGINAL_EXPOSURE_UNKNOWN_OR_EXCESS | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| MARKET_RATE_INVALID | INSTRUMENT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | REFRESH_AND_REEVALUATE_NEW_DECISION_NO_RESEND | Oui, sans renvoi |
| MAX_POSITIONS | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| NO_POSITION | POSITION | REDUCTION, CLOSE | VERIFY_EXACT_POSITION_AND_SUPPORTED_CLOSE_POLICY | Non : revue |
| ORDER_AMOUNT_ABOVE_HARD_CAP | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| ORDER_AMOUNT_INVALID | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| PARTIAL_CLOSE_NOT_RELIABLY_SUPPORTED | POSITION | REDUCTION, CLOSE | VERIFY_EXACT_POSITION_AND_SUPPORTED_CLOSE_POLICY | Non : revue |
| PENDING_BUY_ORDERS | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| PENDING_OR_UNCERTAIN_OPERATION | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_AND_REVIEW_ACCOUNT_STATE_NO_RESEND | Non : revue |
| PERSISTENCE_UNAVAILABLE | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_DURABLE_STATE_AND_REVIEW_NO_RESEND | Non : revue |
| PORTFOLIO_OR_PENDING_INCOMPLETE | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_AND_REVIEW_ACCOUNT_STATE_NO_RESEND | Non : revue |
| POSITION_IDENTITY_UNVERIFIED | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_AND_REVIEW_ACCOUNT_STATE_NO_RESEND | Non : revue |
| POSITION_LIMIT_REACHED_OR_UNKNOWN | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| PRICE_DRIFT_SINCE_PROPOSAL | INSTRUMENT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | REFRESH_AND_REEVALUATE_NEW_DECISION_NO_RESEND | Oui, sans renvoi |
| PROPOSAL_STALE_OR_FUTURE | INSTRUMENT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | REFRESH_AND_REEVALUATE_NEW_DECISION_NO_RESEND | Oui, sans renvoi |
| QUOTE_STALE_OR_INVALID | INSTRUMENT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | REFRESH_AND_REEVALUATE_NEW_DECISION_NO_RESEND | Oui, sans renvoi |
| RECOVERY_OR_ARCHIVE_REQUIRED | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_AND_REVIEW_ACCOUNT_STATE_NO_RESEND | Non : revue |
| RISK_BUDGET_ENTRY_VETO | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| RISK_SELL_VETO | DECISION | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_REQUIRED_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| SELL_CONFIDENCE_VETO | POSITION | REDUCTION, CLOSE | VERIFY_EXACT_POSITION_AND_SUPPORTED_CLOSE_POLICY | Non : revue |
| SELL_DAILY_LIMIT | ACCOUNT | REDUCTION, CLOSE | WAIT_FOR_EXISTING_LIMIT_WINDOW | Oui, sans renvoi |
| SELL_SIZE_EVIDENCE_MISMATCH | POSITION | REDUCTION, CLOSE | VERIFY_EXACT_POSITION_AND_SUPPORTED_CLOSE_POLICY | Non : revue |
| SHADOW_SEED_INCOMPLETE | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| SHADOW_VALUATION_INCOMPLETE | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| SOURCE_CONTEXT_NOT_REQUIRED_FOR_EXACT_CLOSE | ANALYTICS | Aucune : information | DIAGNOSTIC_ONLY_NOT_AN_EXECUTION_PERMISSION | Oui, sans renvoi |
| SOURCE_REFERENCES_INVALID_OR_OPPOSED | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| STRATEGY_ARMING_REQUIRED | STRATEGY | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | EXPLICIT_CONFIGURATION_OR_RELEASE_REVIEW | Non : revue |
| TECHNICAL_VETO | DECISION | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_REQUIRED_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| TRADER_LAYER_UNAVAILABLE | STRATEGY | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_TRADER_LAYER; INDEPENDENT_LEO_ANALYSIS_UNAFFECTED | Oui, sans renvoi |
| TREND_ENTRY_VETO | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| UNMANAGED_OR_COPY_POSITION_ON_INSTRUMENT | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
| UNRESOLVED_LIVE_INTENTS | ACCOUNT | ENTRY, REINFORCEMENT, REDUCTION, CLOSE | RESTORE_AND_REVIEW_ACCOUNT_STATE_NO_RESEND | Non : revue |
| VOLATILITY_ENTRY_VETO | INSTRUMENT | ENTRY, REINFORCEMENT | RESTORE_ENTRY_EVIDENCE_AND_REEVALUATE | Oui, sans renvoi |
