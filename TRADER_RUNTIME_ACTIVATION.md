# Raccordement des preuves et préparation de l’activation

## État examiné

Vérification du 6 novembre 2026. Les PR #81, #82, #83, #84 et #85 sont ouvertes, avec respectivement les têtes `9eefeb4`, `0dfe12a`, `438a0f1`, `c7aee2b` et `bb943e1`. Cette branche prolonge #85. Aucun de ces correctifs n’est présumé déployé. L’intégration dans main pourrait déclencher un déploiement automatique et reste hors de cette préparation.

L’environnement de travail ne contient ni clés eToro, ni accès Upstash, ni clé/service Render. La recherche de connexions a identifié Render comme disponible et non connecté. Le code réellement déployé, ses variables, ses positions et ses résultats SHADOW restent inconnus. Le rapport `trader-activation-status.json` provient du diagnostic local isolé et indique zéro requête authentifiée.

## Changements opérationnels préparés

Le scan actif hydrate le contexte de la décision approuvée par LEO avant la politique traders. Le client d’éligibilité existant est réutilisé avec une expiration de cinq minutes. Le client de coûts dispose uniquement d’un POST informatif construit vers `https://public-api.etoro.com/api/v2/trading/info/costs`. Il accepte seulement une ouverture longue, sous-jacent réel, levier 1, marché et montant USD. Aucun paramètre d’endpoint, de vente, de copie ou d’ordre ne lui est accessible. Il limite ses lectures à vingt par minute, avec cache d’une minute, taille de réponse bornée et délai de huit secondes. Les 401/403/429 déclenchent une temporisation sans répétition automatique.

L’éligibilité d’une entrée utilise le produit et les minimums réellement renvoyés, le levier 1 et un maximum monétaire conservateur calculé à partir du maximum d’unités et du cours. Une clôture complète conserve ses contrôles propres. Les prérequis W8, minimums d’ouverture et support d’ordre par montant ne lui sont pas imposés.

Le dimensionnement est recalculé avant l’exécution depuis le nouveau snapshot. Il exige des positions directes identifiées, des valeurs USD documentées, aucune copie ou structure intégrée non reconstituée, et des ordres en attente complets et vides. Cette première implémentation ne reconstitue pas les ETF, Smart Portfolios, devises économiques ou dérivés inconnus. Les taxonomies sectorielles restent séparées et leurs absences restent visibles. Le contrôle marginal et les limites existantes restent applicables. La réserve effective d’entrée utilise le plus strict des pourcentages normal et consultatif, avec la réserve absolue existante.

Le contrôle d’écrivain provient de #84/#85. L’identité et le lien de provisionnement ne sont plus une constante fausse. Les preuves sont conservées en mémoire dans une session identifiée, expirent après une minute et deviennent invalides lors d’un changement de clé ou de contexte. Une copie JSON d’un objet de preuve ne suffit pas à le rendre valide. Le corps d’ouverture fixe explicitement `settlementType: real`.

Les achats et clôtures utilisent toujours les exécuteurs normaux, le registre des positions gérées, l’intention durable, la limite d’un envoi et la réconciliation. Les plafonds existants sont conservés. Les réductions partielles restent interdites. Les clôtures autorisées conservent leur indépendance par rapport à l’armement des entrées et à leurs critères de dimensionnement.

## Identité officielle et attestation du provisionnement

L’API `/api/v1/me` fournit GCID, realCid et les scopes du contexte authentifié. Une lecture de profil ne démontre aucune exécution. Elle ne fournit pas le lien cryptographique entre un secret chargé et un identifiant de jeton nommé.

Le module exige donc une attestation émise par l’opérateur du provisionnement des secrets, puis vérifie sa concordance avec l’identité officielle et les scopes du contexte courant. L’API ne prouve toujours pas le lien avec le jeton nommé. La preuve reste explicitement `TOKEN_BINDING_UNVERIFIED` côté API, avec une attestation opérateur distincte.

Deux paramètres non secrets seront nécessaires lors d’une préparation ultérieure autorisée.

- `ETORO_CREDENTIAL_REVISION` identifie la version contrôlée du secret dans le provisionnement. Changer les clés impose de changer cette référence.
- `TRADER_PROVISIONING_PUBLIC_KEY` contient la clé publique Ed25519 de l’opérateur. Sa clé privée reste extérieure à LEO et aux journaux.

Le registre protégé `traderExecutionBridge.provisioningReceipt` reçoit une enveloppe avec `payload` et `signature`. La signature base64 porte exactement sur les octets UTF-8 de `JSON.stringify(payload)`. Le payload comporte `kind: ETORO_CREDENTIAL_PROVISIONING`, `environment: REAL`, `contextKind`, `accountRef`, `gcid`, `realCid`, `tokenId`, `credentialRevision`, `issuedAt`, `expiresAt` et éventuellement `closeTerms`. Les identifiants sont non secrets et restent internes. Le rapport les pseudonymise. Les champs supplémentaires et les secrets présents dans le payload sont refusés.

L’opérateur atteste que la référence de version désigne réellement la paire de clés chargée dans le service. La signature seule ne vérifie pas cette opération de provisionnement. Cette exigence et une durée de validité maximale de vingt-quatre heures sont des choix opérationnels conservateurs de cette implémentation, à revoir explicitement si le processus de provisionnement impose une autre durée. Aucun reçu favorable n’a été créé pour le compte réel.

En contexte AGENT, une découverte réussie doit renvoyer un seul portefeuille correspondant aux sélecteurs, puis un seul jeton correspondant au reçu. Un 403 de découverte reste un refus de cette lecture, sans extrapolation aux droits de trading. L’identité officielle et le reçu signé peuvent alors établir le contexte de provisionnement, avec les métadonnées explicitement non vérifiées. Un 401 invalide le contexte courant. Les scopes de ce jeton restent distincts des scopes renvoyés pour les identifiants courants. Aucune agrégation de permissions entre jetons et aucune sélection du premier résultat ne sont permises.

## Coûts et capacité de sortie

La documentation actuelle précise que le calcul hypothétique de coûts rejette `action: close`, les transactions `sell`/`buyToCover` et `positionIds`. Le module ne les envoie jamais. Il refuse les composantes absentes, dupliquées, inconnues, dans une autre devise ou périmées. Des coûts périodiques non nuls exigent encore un modèle de durée de détention. Les coûts renvoyés demeurent estimés. Aucun frais observé n’est inventé.

Les clôtures nécessitent des contraintes et un modèle de frais exhaustif examinés à partir de sources officielles. Chaque élément signé de `closeTerms` porte `instrumentId`, `currency: USD`, `sourceUrl`, `sourceAsOf`, `sourceCheckedAt`, `feeComponentsComplete`, `minimumUsd`, `maximumUsd`, `minimumUnits`, `maximumUnits`, `fixedFeeUsd` et `feeBps`. La date effective de la source et sa dernière vérification sont distinctes. L’URL doit appartenir à eToro et être dépourvue de paramètres ou identifiants de connexion. Les limites et frais absents restent inconnus. Aucun des montants synthétiques des tests ne doit servir au provisionnement.

Le modèle ajoute les frais documentés et une estimation conservatrice du spread observé, puis teste le scénario de quantité et de prix du parcours existant. Il ne garantit pas la possibilité de sortir à une date future. Sans source fiable sur ces contraintes ou sur l’exhaustivité des frais, la capacité de sortie reste bloquante pour les entrées et nécessite une revue pour une clôture.

## Diagnostic et dossier concret

Les routes authentifiées `GET /trader-execution-readiness` et `GET /trader-activation-plan` restent sans envoi eToro. Elles peuvent lire le statut Redis. Les raisons d’un candidat sont calculées par le même `preflight` que l’exécuteur. Un contrôle satisfait retire son veto. Les réponses comportent une résolution pour chaque cause. Un résultat favorable du diagnostic ne soumet aucun ordre.

Le plan rapproche le commit déclaré par Render du commit et de la provenance Render examinés dans la release contrôlée. Le champ `runtimeVerified` reste faux tant que cette concordance n’existe pas. Il ne faut pas renseigner ces preuves depuis les tests.

La commande isolée suivante charge les clés depuis le processus où elle est exécutée et utilise exclusivement le diagnostic GET existant. Elle ne démarre ni serveur, ni scheduler, ni parcours de trading.

```sh
node trader-activation-plan.js --read-only-audit
```

Dans l’environnement local examiné, les résultats sont les suivants.

| Élément | Résultat |
| --- | --- |
| Compte | `ACCOUNT_UNVERIFIED` |
| Jeton nommé | `TOKEN_BINDING_UNVERIFIED` |
| Commit déployé | Inconnu |
| Traders configurés dans ce processus | Liste vide, production inconnue |
| Instruments autorisés dans ce processus | Liste vide, production inconnue |
| Plafond BUY du code | 10 USD au maximum |
| Plafond SELL de ce processus | 0 USD, valeur indépendante à faire approuver |
| Plafond de coûts de ce processus | 0 USD, frais réels encore inconnus |
| Cadence du code | 1 ordre par scan, 4 ordres/24 h, 3 achats, 2 ventes, intervalle 2 h |
| Levier | 1 |
| Résultats SHADOW réels | Non consultés |
| Requêtes authentifiées réalisées | 0 |

Ces valeurs décrivent le processus de diagnostic et les constantes du code. Elles ne décrivent pas le compte de production. Aucun instrument ou montant d’opération concret ne peut encore être soumis à approbation.

Pour obtenir les données manquantes, connecter Render au compte qui possède le service lié à ce dépôt, avec accès en lecture aux métadonnées du service et des déploiements. Les besoins sont le service exact, le commit déployé, la commande de démarrage et la présence des variables nécessaires. Si cette connexion ne permet pas d’exécuter un diagnostic dans le processus équipé des clés, utiliser une console Shell autorisée du service pour lancer la commande isolée et ne transmettre que sa sortie assainie. Les clés ne doivent pas être exportées, collées dans la conversation ou copiées dans GitHub.

Le dossier décrit les changements futurs de mode et d’armement, l’activation séparée des entrées et sorties et les plafonds encore à approuver. Il exige aussi la revue du registre géré et l’approbation chronologique de la version exacte. Aucune initialisation automatique du registre ou adoption de positions personnelles n’est ajoutée.

## Validation

Les tests des adaptateurs utilisent une paire Ed25519 éphémère, des identités et des réponses fictives. Ils vérifient comptes et jetons multiples, permissions contradictoires, rotation, refus, coûts inconnus, sorties sans critères d’entrée et enlèvement des blocages satisfaits. L’achat puis la clôture passent par le contrôleur normal avec ses exécuteurs simulés.

Une répétition supplémentaire charge les quatorze préchargements dans l’ordre de `npm start`, initialise le serveur avec écoute et scheduler simulés, effectue BUY et SELL virtuels et éprouve un envoi sans autorisation durable. Le transport est remplacé avant le chargement. Aucune connexion externe et aucun appel d’exécution n’atteignent le transport. Cette répétition en SHADOW ne démontre pas le fonctionnement réel d’un compte LIVE. Les scénarios de finalité partielle et de redémarrage restent couverts par les tests existants.

Résultats locaux vérifiés sur cette branche : `npm run check` réussi, `npm test` avec 370 tests réussis, zéro échec et zéro test ignoré, `git diff --check` réussi. Le diagnostic isolé a effectué zéro requête authentifiée. La CI distante reste à consulter séparément.

**BLOCKED pour l’activation réelle.** Les accès, le provisionnement, les contraintes officielles de sortie, le registre et les résultats de production restent indispensables. L’activation et le déploiement nécessitent une instruction ultérieure sur leur résultat concret.

## Sources officielles consultées le 6 novembre 2026

- https://api-portal.etoro.com/api-reference/identity/get-authenticated-user-profile
- https://api-portal.etoro.com/api-reference/agent-portfolios/get-agent-portfolios
- https://api-portal.etoro.com/api-reference/trading--real/check-instrument-trading-eligibility
- https://api-portal.etoro.com/api-reference/trading--real/get-what-if-trading-cost-breakdown
