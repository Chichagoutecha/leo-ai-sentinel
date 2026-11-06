# Actifs observés et décision automatique de LEO

Cette branche prolonge la PR #84. Les PR #81 à #84 étaient ouvertes lors de la vérification du 6 novembre 2026. Le code préparé est distinct de la version déployée.

## Parcours

Lors d’un scan, LEO collecte les identités et positions des traders explicitement configurés dans `TRADER_OBSERVER_TRADERS_JSON`. Le module existant conserve l’identité stable et vérifie le pseudonyme avant et après la lecture du portefeuille. Le scan utilise trois GET officiels par trader, jusqu’à cinq traders, avec les quotas, délais et refus du client existant. Une collecte complète manuelle garde ses cinq lectures. Les statistiques déjà collectées conservent leurs dates d’origine. Les endpoints restent ceux documentés dans `TRADER_OBSERVER.md`.

Les actifs connus, autorisés, dotés de cours récents et présents chez des sources sélectionnées entrent dans les candidats d’analyse. Un candidat reçoit une place prioritaire dans les listes existantes. Les plafonds de collecte et d’analyse demeurent ceux du parcours normal. La rotation est déterministe, par fenêtres de deux heures. Les sources opposées, à levier ou ambiguës excluent le candidat. Leur nombre ne crée aucun bonus de confiance.

Le contexte numérique et daté arrive au décideur avant son unique appel IA. La proposition reste soumise à l’analyse indépendante, au contrôle de risque, au budget, à l’éligibilité, aux expositions et à la chaîne normale d’exécution. Le même contexte est conservé lors d’un rafraîchissement d’analyse. Les routes de consultation ne collectent aucun trader et ne changent pas sa sélection.

Une position publique est une détention observée. Sa date de transaction demeure inconnue. Elle ne déclenche pas un achat ou une clôture. L’absence de transactions publiques prouvées empêche de revendiquer une réplication des achats et ventes en temps réel. La politique reste `trader-context-v1`, avec sa qualification existante et son historique. L’ordre de présentation des candidats constitue un changement d’entrée du décideur qui nécessite sa propre évaluation SHADOW avant approbation. Le portefeuille papier normal continue de mesurer les décisions. La comparaison à deux bras existante retourne `UNAVAILABLE_INDEPENDENT_BASELINE_REQUIRED` lorsqu’une décision a reçu des candidats de traders, car elle ne dispose alors plus d’une décision témoin indépendante. Elle ne produit aucune différence de rendement attribuable aux traders pour ces scans. Les nouvelles entrées exigent une release portant `inputVersion: trader-scan-inputs-v1`. Une ancienne approbation ne valide pas ces nouveaux candidats.

## Coordination et diagnostic

Le pont peut désormais utiliser une preuve récente de son verrou Redis obtenue après une sauvegarde réussie. Le contrôle atomique de la PR #84 reste obligatoire à la frontière réseau. Une preuve expirée ou un échec de sauvegarde laisse le verrou non vérifié.

`GET /trader-scan-inputs` expose les derniers candidats, exclusions et dates. `GET /trader-execution-readiness` expose les blocages actuels par entrées et sorties, sans secrets ni identifiants de compte. Les deux routes utilisent l’authentification existante. La seconde peut consulter le statut Redis, sans requête eToro.

## État réel restant à établir

Les clés eToro et Upstash sont absentes de l’environnement de travail. Aucune lecture broker authentifiée ni exécution n’a été réalisée. L’identité du compte et le lien du secret avec le jeton restent inconnus. Le registre géré exige toujours sa revue et la release exige toujours son approbation chronologique. Les adaptateurs de coûts, d’éligibilité liée au compte, de dimensionnement et de capacité de sortie restent à alimenter par des preuves officielles réelles. Le diagnostic explicite ces manques même si les interrupteurs sont activés.

L’univers exécutable reste soumis à WATCHLIST et aux listes autorisées. L’achat d’un instrument extérieur exige identification, éligibilité du compte et intégration aux données et à la politique. Une collecte échouée n’interdit pas les analyses indépendantes de LEO. La cadence de scan et les interactions manuelles peuvent consommer le quota disponible et laisser des observations indisponibles ou périmées.

Ce travail prépare les achats individuels informés par les traders. Une activation native CopyTrader nécessite une fonctionnalité, un périmètre et une validation distincts. Aucun changement de configuration Render, armement LIVE, ordre ou déploiement n’est inclus dans cette branche.
