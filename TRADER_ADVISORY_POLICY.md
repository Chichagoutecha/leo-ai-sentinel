# Politique consultative de contexte traders — v1

## Base et constat

Audit de `main` au commit `eac52058adab7dc51505f9bb52f19bc7e3e0fa40`, après fusion effective des PR #71 à #76. L'arbre local de départ était identique à cette version publiée. Aucun serveur principal, parcours de trading, collecteur ou preload autonome n'est démarré par le nouveau module.

`etoro-trader-observer.js` et `trader-observer.js` conservent identités realCID/GCID, observations publiques datées, positions partielles, gains mensuels/annuels rapportés et statistiques agrégées. Les unités, la complétude, la date effective des portefeuilles et les transactions individuelles ne sont pas établies. Apparitions, disparitions et variations de poids ne sont pas des achats/ventes prouvés. Les anciennes observations corrigées ne fondent pas les propositions.

`trader-exposure-link.js` distingue avoirs directs/copies, portefeuilles observés, intentions et ordres incertains. Son calcul marginal, ses contrôles de provenance et ses limites de dimensionnement sont réutilisés. Aucune allocation publique n'est ajoutée aux avoirs de LEO. Les compositions et taxonomies inconnues ne deviennent pas une diversification.

`all-in-cost-shadow-agent.js` conserve notamment des coûts estimés, des planchers de coûts et des composants inconnus sur des observations d'achats. Son dernier événement global ne constitue pas une estimation complète liée au sens, au montant, au compte et au scénario présents. Le nouveau module ne l'importe pas : cet import pourrait installer un observateur autonome. Aucun plancher n'est converti en coût total, aucune estimation en frais observé.

Le parcours existant passe par les analyses, le conseil, le contrôleur de risque et les exécuteurs. La politique consultative n'est pas branchée dans ce parcours et ne modifie aucun vote, dimensionnement, veto ou exécution. Elle utilise seulement des idées déjà conservées. Le journal courant ne conserve pas une preuve exploitable de prix de référence initial ni la cible broker exacte d'une vente ; ces informations restent inconnues, de même qu'une approbation de risque non explicitement conservée.

## Définition de « meilleur trader »

Un trader ne serait qualifiable qu'avec des preuves datées et comparables pour chaque critère ci-dessous, puis une validation prospective séparée. Cette version retourne `ranking: UNAVAILABLE`, `score: null`, `rank: null`. Elle ne classe pas sur les copieurs ou le gain récent et n'attribue aucun bonus aux absences.

| Critère | Ce qui est réellement mesurable ici | Limite bloquant la qualification |
| --- | --- | --- |
| Historique | Nombre de mois rapportés, premier/dernier mois, trous mensuels | Complétude et conventions de rendement non vérifiées |
| Rendement et drawdown | Données rapportées accessibles dans l'observateur | Fenêtres et bases comparables non établies ; pas de recomposition supposée |
| Volatilité | Indisponible | Série comparable et conventions non vérifiées |
| Concentration | Plus grand poids de position rapporté, sous-total descriptif partiel | Ni concentration totale par instrument ni transparisation complète |
| Levier | Maximum connu sur les positions visibles | Positions non visibles et risque dérivé inconnus |
| Stabilité | Durée de visibilité et observations distinctes pour la sélection de sources | Ne prouve pas une stabilité de style ou de risque |
| Rotation/coûts | Indisponibles pour le trader | Pas de transactions ou d'unités vérifiées ; poids variables insuffisants |
| Indépendance | Actifs communs visibles dans la vue d'exposition | Ni corrélation ni liens de copie établis |

La confiance vaut au mieux `LOW_CONTEXT_ONLY`, jamais une probabilité de succès. Une sélection de sources observables n'est pas une sélection de traders démontrés meilleurs.

## Hypothèses comparées

| Hypothèse | Décision v1 | Justification |
| --- | --- | --- |
| Suivre les transactions explicites | Indisponible | L'observateur ne dispose d'aucune preuve individuelle de transaction |
| Consensus pondéré indépendant | Indisponible | Qualité comparable, indépendance et poids non établis |
| Contexte complémentaire aux idées propres de LEO | Retenue pour recherche consultative | Utilise seulement la présence connue, sans lui attribuer de causalité transactionnelle |

Aucun poids numérique de trader n'est attribué. Plusieurs sources détenant le même instrument ne multiplient pas la confiance. Une idée BUY/SELL propre à LEO reste indispensable. Les positions courtes, directions inconnues, signaux contradictoires ou leviers non unitaires bloquent la proposition. Des sources encore longues lors d'une idée SELL de LEO produisent un avertissement à examiner, sans annuler automatiquement l'analyse propre de LEO.

## Cycle de sélection et journal

Identités stables uniquement. `PROBATION` exige des observations différentes et une durée minimale avant `SELECTED_CONTEXT_ONLY`. Une actualisation de pseudonyme ne crée pas une identité. Une duplication ou contradiction d'identité suspend la source. La perte de visibilité suspend immédiatement son usage et mène à `EXITED` après une durée configurée ; elle ne liquide jamais les positions de LEO. La reprise repasse en probation, avec délai supplémentaire après une sortie. Un changement de paramètres recommence la qualification, sans effacer le passé.

Chaque évaluation conserve date, configuration complète, version/identifiant de politique, critères disponibles/manquants, états de sélection et motifs/veto des propositions. Les identités retirées de la liste observée restent dans le registre, avec leur état historique. L'échantillon initial est choisi par l'utilisateur : le module ne prétend pas supprimer le biais de survivance de l'univers eToro. Les réévaluations identiques sont idempotentes ; les évaluations antidatées sont refusées.

Le stockage existant conserve au plus 120 évaluations et 100 identités. La compaction à 48 Ko (4 Ko dans la sauvegarde critique) supprime des évaluations anciennes en signalant `historyTruncated`. Si les états courants ne tiennent pas dans le budget, le module se désactive avec un motif d'archivage requis au lieu de redémarrer une sélection vierge. Un archivage externe autorisé sera nécessaire pour une étude historique exhaustive ; aucun n'est créé ici.

## Paramètres de recherche

Configuration validée via `TRADER_ADVISORY_POLICY_JSON` ou l'argument du module. La variable n'est pas créée/modifiée sur Render. Les paramètres sont enregistrés à chaque évaluation sous `trader-context-v1`. Ces valeurs initiales sont des choix prudents de recherche, pas des optimums estimés ou validés sur un backtest.

| Paramètre | Défaut | Rôle |
| --- | --- | --- |
| minHistoryMonths | 12 | Seuil descriptif de profondeur ; ne suffit pas à qualifier |
| qualifyingObservations / probationDays | 3 / 7 jours | Éviter une sélection sur une unique observation |
| suspensionExitDays / reentryDays | 30 / 14 jours | Stabiliser le cycle de sélection |
| observationMaxAgeMs / decisionMaxAgeMs | 30 min / 30 min | Rejeter sources et idées trop anciennes |
| quoteMaxAgeMs | 5 min | Borne de fraîcheur cours, coût, éligibilité et cache d'exposition |
| maxDecisionPriceDriftPct | 2 % | Variation absolue depuis le prix de référence propre à LEO |
| maxCostPct | 1 % | Borne de coût complet estimé pour le sens et montant exacts |
| maxOrderUsd | 10 USD | Plafond consultatif d'achat, jamais une autorisation LIVE |
| maxInstrumentWeightPct / minCashReservePct | 15 % / 20 % | Concentration maximale et réserve minimale avec preuves complètes |
| reductionFraction | 25 % | Fraction des unités de la position broker précise proposée en réduction |
| maxHistory | 120 | Rétention maximale avant marquage de troncature |

## Entrée, maintien et sortie

- Entrée/renforcement : idée BUY propre à LEO, source sélectionnée et présence longue actuelle ; montant borné au plafond et contrôlé par le calcul marginal incluant les achats en attente. Cash, equity, transparisation et risques non reconstitués doivent être vérifiés.
- Maintien : aucune idée nouvelle signifie aucune opération. Une disparition publique ou une suspension ne constitue pas une vente.
- Réduction : idée SELL propre à LEO sur une position directe broker identifiée ; unités réellement connues, fraction configurée. Aucun lot indépendant artificiel.
- Sortie : seulement si l'idée propre à LEO indique explicitement la sortie de cette position exacte. Pas de liquidation de toutes les positions partageant le symbole, ni vente des enfants de copies.
- Signaux tardifs/prix : fraîcheur des sources et de l'idée contrôlée ; variation mesurée depuis le prix de référence de LEO. Le prix de transaction du trader est inconnu, son écart reste `null` ; le prix d'ouverture historique ne le remplace pas.
- Coûts et éligibilité : schéma interne conservateur pour des preuves futures, liées au même compte, instrument, sens, devise, montant, produit sans levier et limites d'ordre. Données manquantes, coûts non couverts, minima incompatibles, devise étrangère, incertitudes sur les ordres ou hard veto empêchent `ADVISORY_REVIEW_ONLY`. Même cet état n'autorise aucune exécution.

## Intégration et limites opérationnelles

`GET /trader-advisory-status` est authentifié et lit uniquement le rapport et l'historique en mémoire. `POST /trader-advisory-evaluate`, authentifié avec corps `{}`, évalue les caches et sauvegarde via le mécanisme existant. Aucun paramètre de preuve financière n'est accepté par HTTP. Pas de collecte au démarrage, pas de tâche planifiée, aucun appel eToro ou fournisseur.

Le cache d'exposition provient d'une consultation existante de `/portfolio-universe-status` ou d'une prévisualisation déjà demandée. Il expire et devient inutilisable si les intentions d'ordre ont changé. Il n'est pas restauré comme preuve fraîche après redémarrage. L'évaluation ne déclenche jamais cette consultation. Le registre d'éligibilité est exposé comme preuve cache séparée ; il n'est pas transformé en permission de trading.

Dans l'intégration actuelle, les coûts contextualisés, le prix de référence de décision et la cible exacte SELL ne sont pas raccordés comme preuves suffisantes. Les propositions résultantes restent donc sous veto ; aucune préparation de preuves de production n'est supposée par les fixtures de test. Les données synthétiques démontrent le calcul d'un scénario consultatif complet, pas l'accessibilité réelle de ces données ni une performance de stratégie.

Les étapes ultérieures sont : enregistrer les preuves décisionnelles utiles sans secrets, vérifier les accès réels dans l'environnement équipé, raccorder un adaptateur de coûts/éligibilité du même compte, compléter les expositions et évaluer prospectivement en SHADOW face à des références. Aucune adaptation LIVE, copie ou activation automatique n'est incluse.

## Vérifications

`npm run test:trader-advisory`, `npm run check`, `npm test` et `git diff --check`. Les scénarios utilisent des réponses simulées : sélection persistante, sorties/réintégration, identité, données manquantes, contradictions, maintien sans opération, achats et réductions, sorties ciblées, prix/coûts/expositions et absence de réseau. Les routes sont testées sans démarrer de serveur ni écrire de sauvegarde de test.
