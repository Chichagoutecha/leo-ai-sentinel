# Politique de clôture des positions gérées

Cette branche repose sur la PR #82 et sa dépendance #81. Le contrôle concerne les entrées et clôtures REAL du bot. Le parcours de simulation conserve ses propres règles.

| Contrôle | Entrée REAL | Clôture protectrice REAL |
| --- | --- | --- |
| Plafond | Plafond BUY existant et contrôle préalable des scénarios de clôture | Plafond SELL explicitement configuré |
| Cadence | Limites communes et BUY, avec une place disponible pour un SELL après le BUY | Limites communes et SELL |
| Réservation | Cash, exposition, ordre en attente et réservation durable existants | Réservation durable et absence d’ordre incertain |
| Cible | Instrument autorisé, position directe sous-jacente longue à levier 1 | Même compte, instrument, positionId et quantité que le registre géré |
| Preuves de clôture | Intervalle de quantité projetée, bornes de taille, disponibilité et coûts | Nouvelle vérification sur la quantité et le cours réels |

Le budget SELL utilise `TRADER_EXECUTION_MAX_EXIT_NOTIONAL_USD`. Une valeur absente ou invalide exige une revue. Pour migrer une configuration sans valeur SELL explicite, la proposition est de faire valider le dernier plafond effectif avant de le reporter dans le réglage SELL. Une augmentation éventuelle exige une décision séparée. Les montants de tests sont synthétiques.

La vérification d’entrée utilise un scénario bas et un scénario haut autour du cours, avec la tolérance de dérive déjà attachée à la décision. Elle compare le nouveau lot au minimum et tient compte des unités déjà détenues sur l’instrument pour les maxima, au cas où le broker regrouperait les unités. Elle exige une place pour une clôture dans le quota actuel, sous réserve de la cadence et du délai existant de deux heures. Cette place est un contrôle de capacité au moment de l’entrée. Elle ne constitue ni une réservation d’exécution chez le broker ni une garantie future de marché, de coût, de prix ou de sortie.

Les éléments de clôture doivent être frais et associés au compte, à la proposition, à l’instrument et au produit. Pour une entrée, l’estimation doit couvrir la taille de l’achat et un intervalle cohérent de quantités. Pour une sortie, les éléments doivent porter sur le positionId et les unités exactes. Le contexte d’exécution attend ces preuves via `traderExecutionCloseEvidence`. Le dépôt ne fournit pas encore d’adaptateur de production capable de renseigner ces bornes et ces coûts de façon vérifiée. En leur absence, le contrôle oppose un veto. Les preuves d’identité et de disponibilité de production restent également à établir.

Les points d’entrée REAL d’achat et de vente exigent une opération gérée réservée. Cela retire le recours historique à une clôture choisie par symbole et ferme le contournement du contrôle de sortie par un achat REAL direct. Les positions personnelles, copiées ou anciennes non inscrites au registre géré nécessitent une revue opérateur. Les sorties bloquées ou incertaines apparaissent dans le résultat de traitement et, pour les opérations inscrites, dans le statut du pont. La revue ne déclenche ni nouvelle tentative ni clôture de substitution.

## Sources eToro et réduction partielle

- [Clôturer une position par unités](https://api-portal.etoro.com/api-reference/trading--real/close-position-by-units) documente le ciblage par positionId et `UnitsToDeduct`.
- [Éligibilité de l’instrument](https://api-portal.etoro.com/api-reference/trading--real/check-instrument-trading-eligibility) expose notamment la capacité de clôture partielle et des caractéristiques de quantité. Ces champs ne suffisent pas à prouver la précision et les minimums applicables à une réduction précise et à son reliquat.
- [Consulter une clôture et ses exécutions](https://api-portal.etoro.com/api-reference/trading--real/get-close-order-information-and-closed-position-details) distingue les états et les unités exécutées. La réconciliation de #82 conserve le reliquat d’une clôture partiellement remplie.

La réduction partielle demandée par le bot reste interdite. La prise en compte d’un remplissage partiel involontaire d’une clôture complète reste active.

Les vérifications locales couvrent le dépassement du plafond BUY, le plafond SELL absent, les scénarios de hausse et de baisse, les minimums incompatibles, le marché fermé, la quantité modifiée, les coûts, la capacité de sortie et le remplissage partiel. La suite complète compte 342 tests réussis. Aucun ordre, armement, changement Render, copie ou déploiement n’a été effectué.
