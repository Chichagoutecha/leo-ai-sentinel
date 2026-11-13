# Analyse descriptive de marché et preuves du portefeuille agent existant

Date : 13 novembre 2026. Base du travail : `main`, commit `21647491d645c20966c50a698df39cb4bccaf836`.

## Périmètre

Ce lot ajoute une analyse descriptive aux informations déjà transmises à la décision. Il ne crée ni portefeuille agent, ni client d’ordres, ni permission. Aucun appel de marché ou de courtage n’a été réalisé pour développer ou tester le lot ; les tests utilisent des données synthétiques et les connexions externes sont bloquées.

La copie locale précédente sur `feat/trader-recent-openings-shadow` comportait des modifications non enregistrées, notamment `decision-evidence.js` et `decision-portfolio-evidence.js`. Ces travaux ont été consultés comme contexte puis laissés intacts. Ce lot utilise un worktree isolé depuis main et n’incorpore pas ces modifications non publiées.

Les PR #81 à #88 restent ouvertes à la lecture initiale. Elles forment une pile de branches, avec #81 sur main, puis #82 sur #81, jusqu’à #88 sur #87. Leurs adaptations du runtime et du suivi d’ordres ne sont pas présumées fusionnées ou déployées. La PR #38 concernant un adaptateur historique Alpaca et la PR #37 sur sa provenance sont également ouvertes : aucun de ces clients n’est ajouté au parcours de main.

Aucune consultation de Render, modification d’environnement, activation LIVE, création ou modification d’un compte agent, fusion ou déploiement n’appartient à ce lot.

## Audit du parcours existant

| Étape | Code et sources réellement présents sur main | Fréquence, couverture et limites |
| --- | --- | --- |
| Portefeuille | `getPortfolio`, `extractPortfolioSummary`, `validateLivePortfolioIdentity`, `trader-exposure-link.js` | Réponse du contexte API courant déjà lue par `buildRuntimeContext`. Le portefeuille de décision PAPER est distinct de cette réponse. Une configuration confirmée ne prouve pas un compte copieur séparé. |
| Cotations | `getMarketRates`, `normalizeMarketRates`, eToro `/market-data/instruments/rates` | Prix, spread, horodatage source et état du marché. Seuil existant de fraîcheur : 30 minutes. La fraîcheur est recalculée, pas déduite d’un ancien libellé FRESH. |
| Contrôle des prix | `buildDataIntegrityReport` / `buildMarketDataFusionReport` | eToro, Twelve Data et Alpha Vantage selon la configuration. Contrôle secondaire limité à trois actifs par scan par défaut. Consensus et prix d’exécution restent distincts. |
| Historiques | `getHistoricalCandles` → `getEtoroCandles`, `getTwelveDataCandles`, `getAlphaVantageCandles` | eToro prioritaire ; fallback/croisements selon les options existantes. Source retenue, divergences, cache périmé et disponibilité sont déjà exposés. Pas d’appel ajouté. |
| Techniques | `buildTechnicalAnalysisReport`, `analyzeCandleSeries` | Huit actifs par scan par défaut ; 120 bougies intraday OneHour et 260 OneDay, plafonnées à 1 000 ; trois traitements concurrents. RSI, MACD, ATR, moyennes, rendements par périodes, volatilité et drawdown existent déjà. |
| Benchmarks | Régime SPY/QQQ/BTC, performance du compte et benchmark PAPER | Les benchmarks restent informatifs. L’analyse ajoutée compare des fenêtres de prix identiques, pas une performance totale ou une prévision. |
| Mémoire courte | `trendMemory` | 48 points maximum par actif, espacement minimal de dix minutes. Ce sont des observations de cotations irrégulières, pas des chandeliers boursiers réguliers. |
| Stockage | `technicalCache`, `historicalCache`, état persistant existant et Upstash | Caches de 45 minutes par défaut. Le mode persistant compact omet déjà certains caches reconstructibles. Une reprise ne transforme pas un ancien rapport en observation actuelle. Budget Upstash existant : 900 000 octets par défaut, inchangé. |
| Orchestration | `buildRuntimeContext` → agents → `askDecisionAgent` → RiskController | Watch à 5/20/35/50 minutes ; scan à la minute 10 toutes les deux heures ; options de cron inchangées. Le nouveau rapport est joint aux agents et au journal, sans vote, veto, multiplicateur ou branche d’exécution supplémentaire. |

Les clés et états des fournisseurs ne prouvent ni un abonnement actif ni la disponibilité de toutes les données. Les caches, les bornes d’actifs, les reprises GET existantes (deux par défaut pour eToro) et les quarantaines sont réutilisés. Aucun nouveau budget fournisseur, abonnement, cadence ou rafraîchissement n’est créé. Les limites commerciales réelles n’ont pas été testées.

## Ce qui change

`market-analysis-evidence.js` est un module pur. Il ne dispose d’aucun transport réseau ni accès à un client de courtage ou de stockage.

- Rendements à 1, 5, 20 et 60 observations, dans chaque intervalle disponible. Un horizon incomplet vaut null ; les périodes ne sont pas renommées en jours calendaires.
- Écart-type d’échantillon des rendements par barre, sans annualisation, et drawdown sur au plus 61 observations.
- Volume ou activité uniquement si le champ est effectivement fourni. Le dernier volume ne glisse pas depuis une barre antérieure. La comparaison utilise les vingt observations précédentes complètes ; zéro déclaré reste zéro, absence reste null.
- Exclusion des dates invalides, futures, doublons contradictoires et barres dont la date plus la durée nominale de l’intervalle dépasse le moment d’analyse. Ce filtre conservateur utilise le début UTC nominal ; il ne certifie pas un indicateur de finalité fournisseur non reçu.
- Comparaison au benchmark sur les mêmes bornes temporelles. Le choix est un proxy actions large SPY pour les catégories actions reconnues et BTC pour les cryptos ; les catégories non établies restent sans benchmark. Aucun benchmark n’est téléchargé en supplément.
- Corrélation de Pearson sur les rendements ayant exactement les mêmes timestamps de début et de fin, avec au moins vingt paires. Variance nulle, devise inconnue ou différente, intervalle différent ou base de prix non établie entre fournisseurs donnent une corrélation inconnue, jamais zéro.
- Un même instrument est un chevauchement direct ; il n’est pas présenté comme une preuve de diversification.
- Les cotations et séries conservent leurs sources, dates, devises et statuts. Les métadonnées de devise déjà reçues sont conservées dans les normalisations. Ni ticker, ni heure de collecte, ni convention de valorisation USD ne remplace une devise de série inconnue.
- Les séries restent lisibles si une source facultative manque. Les analyses techniques et de tendance précédentes sont conservées avec leur statut et leur date ; elles ne sont pas transformées en prévision de rendement.

La correction des volumes concerne uniquement leur lecture dans les normalisateurs et leurs statistiques historiques. Le helper numérique général du portefeuille n’a pas été changé.

## Rattachement au portefeuille existant

Le rapport réutilise `normalizeOwnedPortfolio` et `pendingExposure`, sans recopier un second modèle de positions ou inventer des lots.

Le rattachement nécessite la confirmation de configuration existante pour un contexte AGENT_PORTFOLIO REAL et une réponse du portefeuille courant récente et valide. En l’absence de cette preuve de configuration, les quantités attribuables à l’agent restent indisponibles. La portée exacte est affichée : confirmation existante du contexte API, pas nouvelle preuve d’identité propriétaire, d’identité copieur, de remplissage ou de performance réelle. L’horodatage propre du snapshot du courtier demeure inconnu si seul le moment de collecte est fourni.

- Les identifiants d’instruments servent à relier les historiques aux lignes effectivement observées.
- Les doublons et copies natives sont traités par le normaliseur existant.
- Une somme de valeurs connues est un sous-total connu. Elle ne remplace pas les lignes absentes.
- Les pondérations sur ce sous-total portent ce nom. Les pondérations de l’ensemble positions + crédit ne sont fournies que si la couverture directe est complète, le crédit déclaré connu et non négatif, et qu’aucune structure de copie native ne demande un dénominateur non établi.
- La valorisation reste une estimation du capital du compte selon la convention PnL USD existante. Les risques bruts/nets, le levier économique, les expositions de change et les constituants manquants ne sont pas reconstruits.
- Les ordres en attente restent distincts des positions. Les montants repris sont des bornes supérieures déclarées, pas des soldes restant à exécuter certifiés ni du cash réservé.
- Un SELL incertain ne réduit pas les positions détenues. Les `ordersForClose` du PnL ne deviennent pas une preuve d’ordre SELL en attente.
- Ni un portefeuille PAPER, ni un trader observé n’est présenté comme le portefeuille agent existant.

## Intégration et bornes

`buildCachedMarketAnalysis` utilise uniquement la réponse REAL, les caches et les analyses déjà présents dans `buildRuntimeContext`. Il est aussi réutilisé après l’éventuel rafraîchissement technique spécifique à la décision qui existait déjà. Aucun appel ne lui est ajouté.

Le rapport est joint sous `foundation_agents.marketAnalysisEvidence`, puis conservé dans les traces de décision et l’état existant. Les optimiseurs de contexte v1/v2 conservent les métriques, les valeurs nulles, les unités et les réserves de couverture, y compris dans leur projection réduite.

Bornes : 64 actifs et 1 000 barres par série pour le calcul descriptif ; douze liens au portefeuille par actif, priorisés par valeur connue. La projection décision/persistance conserve huit actifs, trois liens par actif et douze lignes de concentration/ordres. Les nombres d’éléments omis sont explicites et restent présents après plusieurs compactages. Le focus de la trace de décision conserve l’actif choisi en priorité.

Le dernier rapport est exposé via `/data-sources` comme snapshot, sans rafraîchissement fournisseur. La fraîcheur est recalculée à la lecture ; les anciens libellés ne restent pas FRESH. Les calculs locaux et leur persistance utilisent les budgets et la sauvegarde déjà existants.

Les corps de huit fonctions existantes ont été comparés à la base et restent identiques : `getPortfolio`, `resolveEtoroPortfolioContext`, `riskController`, `executeBuy`, `executeSell`, `executeControlledDecision`, `buildAgentCouncil` et `getProgressiveOrderPolicy`. L’univers, les listes d’actifs/catégories autorisés, les plafonds d’ordre et le démarrage de production ne changent pas.

## Validation

Les connexions externes sont refusées par `test-no-provider-network.cjs`, chargé uniquement par les tests. Les simulations peuvent remplacer leurs transports ; les sockets externes restent bloquées. Le workflow CI applique aussi ce garde-fou aux tests et aux préchargements, sans désactiver de contrôle existant.

Résultats locaux :
- `npm run check` : réussi.
- Suite `npm test` : 325 tests réussis, dont dix-huit nouveaux cas du module et de son intégration.
- Préchargements IA, projection du contexte, préflight de production, concurrence du budget et gestion des usages absents : réussis.
- `git diff --check` : réussi.

Les tests couvrent prix périmés, collecte trop ancienne ou future, historique court/troué, absence de volume, zéro réellement observé, devise incompatible/inconnue, bases de prix incompatibles, corrélations inconnues ou mesurées à zéro, benchmark absent, source isolée indisponible, doublons, barres inachevées, liens agent/ordres, snapshots anciens et conservation des valeurs à travers la compression.

Ces résultats valident le code et les scénarios simulés. Aucun compte agent, quota commercial, fournisseur, prix, ordre REAL/DEMO, performance réelle ou déploiement n’est certifié par ces essais. Les colonnes de devise absentes dans les réponses existantes peuvent maintenir des comparaisons indisponibles ; aucun appel supplémentaire n’est effectué pour les remplir.
