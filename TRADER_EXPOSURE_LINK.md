# Observations de traders et expositions détenues

## Version examinée et intégration

Base examinée : `main` au commit `d247ce5b72c0eee7832494146bda6e202d51c3a1`.
Les PR #72 (expositions), #74 (éligibilité) et #75 (observateur) étaient ouvertes, non fusionnées. Cette branche réunit leurs travaux pour rendre la liaison testable ; elle ne les déclare pas fusionnées sur main. La PR #71 SHADOW n'est pas intégrée par cette modification.

## Sources et périmètre

Sources officielles consultées :

- https://api-portal.etoro.com/core/guides/calculate-total-invested : positions, enfants de `mirrors`, trésorerie de copie et ordres manuels en attente ; périmètre USD.
- https://api-portal.etoro.com/core/guides/calculate-profit-loss : PnL non réalisé des positions directes et des enfants de copies.

La vue réutilise la lecture REAL PnL existante et le cache de l'observateur. Elle n'ajoute aucune collecte sociale, aucun appel d'éligibilité, ni aucun fournisseur de cours ou de compositions. Un appel à la prévisualisation nécessite une seule lecture PnL pour éviter un scénario fondé sur un portefeuille périmé. Les identifiants disponibles ne prouvent pas ici l'identité du compte propriétaire ou agent. Aucune vérification authentifiée n'a été réalisée dans cet environnement sans clés.

## Vue et scénarios

`GET /portfolio-universe-status`, protégé par le mécanisme existant, expose `ownershipAndTraderExposure` :

- `owned.direct` : positions du compte hors copie ;
- `owned.nativeCopies` : enfants de copies réellement présents dans la réponse, distincts des enveloppes et de leur trésorerie ;
- `observedOnly` : instruments communs entre traders publics observés, jamais ajoutés au capital du compte ;
- `proposalsNotExecuted` : hypothèses conservées, sans exécution ;
- `pending` : ordres et intentions, avec sous-totaux connus et éléments incertains séparés ;
- `dimensions` : instrument, secteur, émetteur, zone et devise économique, avec couverture et motifs d'incomplétude.

Un même identifiant de position broker ne compte qu'une fois, même s'il figure à la racine et dans un miroir. Des représentations contradictoires sont exclues des totaux complets. Des positions distinctes sur un même instrument s'additionnent. Un conteneur de copies absent signifie inconnu ; une liste explicitement vide est distinguée. Les sous-portefeuilles non documentés ne sont pas reconstruits par supposition.

`POST /trader-exposure-proposal-preview` valide une liste fermée de champs puis calcule un scénario, sans ordre. Une vente doit désigner une position directe existante et une quantité réelle ou la totalité de la position. Une fraction analytique ne crée jamais de lot broker indépendant. Les ventes de positions de copie ne sont pas autorisées par cette prévisualisation.

Les achats en attente connus constituent une borne haute rapportée, sans preuve de quantité restante. Les ventes en attente ne diminuent jamais les avoirs. Un ordre incertain, une intention non réconciliée, une devise incompatible ou une position inconnue empêchent le total après opération ; les composantes connues restent visibles. Un zéro de départ n'est possible qu'avec une couverture complète. Les limites de dimensionnement restent indisponibles sans preuves complètes et récentes de liquidités, d'equity et de transparisation.

`GET /trader-exposure-proposals` lit uniquement les traces conservées. Les deux nouvelles routes utilisent l'authentification existante. Le POST crée seulement une trace locale de simulation, pas une instruction broker.

## Traçabilité et indépendance

Une proposition porte un UUID et des références vérifiées aux identifiants stables des traders, observations ou événements encore disponibles. Ces références ne prouvent pas une transaction du trader. Les observations anciennes, remplacées ou incompatibles avec l'instrument ne fondent pas un scénario complet. Le lien à un ordre futur exige un `proposalId` explicite ; ni le symbole ni la proximité temporelle ne suffisent. Une référence d'ordre n'est pas une preuve de remplissage. Aucun lien à une position exécutée n'est inventé.

Les traces sont bornées à 20 dans le stockage existant (5 dans sa forme critique compacte). Il ne s'agit pas d'un registre historique illimité. Le nombre de traders détenant le même instrument est un indicateur de concentration commune, pas de sources indépendantes ; les relations de copie et corrélations non démontrées restent inconnues.

## Limites des mesures

Les montants connus sont des estimations du capital USD investi plus PnL déclaré. Ils ne représentent ni le notionnel brut, ni le risque net, ni un rendement. Les anciens champs de profit restent des estimations non vérifiées. Levier, positions courtes et règlement non identifié signalent un risque non reconstitué. Aucune conversion FX n'est supposée ; devise de valorisation USD et devise économique sont distinctes.

La date de récupération n'est pas une date effective fournie par eToro. Sans métadonnées officielles datées et complètes, les dimensions restent `UNAVAILABLE` ou `INCOMPLETE`. Les compositions ETF et Smart Portfolios ne sont pas disponibles dans la configuration actuelle : la fiche du véhicule ne remplace pas ses composants. Aucune enveloppe inconnue ne devient une diversification présumée. Les données d'un portefeuille agent ne prouvent pas les expositions de ses éventuels copieurs.

Les autorisations LIVE, chemins d'exécution, variables Render et commandes de démarrage ne sont pas modifiés. Aucun ordre, copie ni déploiement n'est effectué.

## Vérification

`node --test test-trader-exposure-link.js` couvre doublons, copies absentes, identifiants contradictoires, devises incompatibles, positions inconnues, sources périmées, scénarios BUY/SELL et lecture HTTP unique sans exécution. La suite utilise exclusivement des réponses simulées. Exécuter aussi `npm run check`, `npm test` et `git diff --check` sur la branche assemblée.
