# Découverte des actifs candidats, séparée des achats

## Ce que fait le parcours

`GET /analysis-candidates/lookup?symbol=NVDA` est une recherche manuelle, protégée par le secret habituel du dashboard. Elle ne fait aucun scan planifié et n'appelle aucun endpoint d'exécution. Elle résout un symbole exact via la recherche eToro, puis demande une cotation de cet instrument. Elle met le résultat en cache cinq minutes et limite les recherches à dix par minute par processus.

Le parcours fournit un identifiant eToro et, si la réponse le permet, un prix observé avec sa date et sa source. Il ne calcule aucun signal d'achat ou de vente et ne transmet pas le candidat à la stratégie de trading.

## Provenance et champs volontairement prudents

- La correspondance exacte du symbole et l'identifiant proviennent de la recherche eToro.
- La cotation éventuelle provient de l'API de taux eToro. Sa date est exposée, mais la politique de fraîcheur de stratégie n'est pas appliquée à cette prévisualisation.
- La catégorie, la place de cotation et le secteur ne sont pas déduits si les réponses vérifiées ne les fournissent pas. Ils restent `UNCLASSIFIED`, inconnus ou explicitement marqués comme données de configuration non vérifiées.
- Une correspondance de recherche n'établit pas qu'un instrument est achetable. L'éligibilité technique reste `NOT_CHECKED`; la politique de risque reste `NOT_EVALUATED`; l'autorisation d'achat reste toujours `NOT_AUTHORIZED`.
- La configuration `ANALYSIS_ONLY_CANDIDATES_JSON` est rendue dans le registre d'analyse sans ajout à `WATCHLIST`, aux règles d'ASSET_RULES ou à la liste d'autorisation d'achat.

Les secteurs d'intérêt pris en charge comme étiquettes non vérifiées sont : semi-conducteurs/IA, cybersécurité, robotique/automatisation, santé/technologies médicales, énergie/électrification et autre. Une étiquette de secteur est une indication de recherche, pas une classification fournisseur.

## Sources et limites

La documentation officielle eToro explique la résolution du symbole par `GET /api/v1/market-data/search?internalSymbolFull=...` et recommande de vérifier l'égalité exacte du symbole avant de retenir l'identifiant : https://api-portal.etoro.com/guides/get-instrument-id

La documentation officielle décrit séparément les limites de lecture de l'API (généralement 60 requêtes par minute par user key) : https://api-portal.etoro.com/getting-started/rate-limits

Les identifiants eToro, les permissions du compte et la disponibilité de chaque actif n'ont pas été testés contre le compte Render. Une réponse de recherche et une cotation n'équivalent ni à l'éligibilité technique `check-instrument-trading-eligibility`, ni à une autorisation de la politique de risque, ni à une décision d'achat.
