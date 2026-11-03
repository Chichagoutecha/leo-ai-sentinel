# Continuité de l’exécution

Les instances d’un même périmètre doivent utiliser la même base Upstash et la même clé d’état. Le verrou Redis expire après deux minutes. Une sauvegarde compare la révision et le contenu de l’état restauré avant d’acquérir ou de renouveler le verrou. Un processus resté sur une version antérieure doit repartir du dernier état durable. Le stockage JSON local reste disponible pour l’observation.

Le préchargement installé par `npm start` contrôle les écritures d’exécution eToro à la frontière réseau, après les transformations des autres préchargements. Redis vérifie la génération du verrou, la réservation durable, l’identité de la requête et les contrôles opérateur dans une seule opération. Une trace durable est créée avant l’envoi. Elle empêche un nouvel envoi même si le verrou expire ou si la réponse du courtier est perdue. La trace est libérée uniquement après sauvegarde d’une preuve terminale vérifiée et concordante avec le portefeuille. Les preuves insuffisantes demandent une revue. Le parcours DEMO existant ne fournit pas de lecture de finalité vérifiée et peut donc laisser cette trace ouverte.

## Commandes opérateur

Toutes les routes utilisent l’authentification existante. Chaque POST prend uniquement un champ `confirm` égal au dernier segment de la route.

| Route | Effet |
|---|---|
| `GET /execution-continuity` | État du stockage, du verrou, des collectes et des intentions. Les indicateurs d’action décrivent uniquement les restrictions de coordination. |
| `POST /execution-continuity/block-entries` | Refuse les nouvelles autorisations BUY. Les sorties restent soumises à leurs propres contrôles. |
| `POST /execution-continuity/suspend` | Refuse toute nouvelle autorisation d’envoi dans ce périmètre. Les demandes ayant déjà franchi la frontière restent à réconcilier. |
| `POST /execution-continuity/request-liquidation` | Enregistre une demande durable à examiner par un opérateur. |

Les contrôles sont persistants et sans expiration. La reprise des envois requiert une procédure opérateur distincte. Une réponse 503 signifie que l’écriture du contrôle n’a pas pu être vérifiée. La consultation de l’état permet de vérifier les drapeaux lorsque le stockage revient.

La coordination couvre les processus qui utilisent cette version et le même état durable. La restauration nécessite un snapshot cohérent avec les clés de contrôle et de verrou, y compris la trace des envois en cours. Après un retour à un état ancien, une migration de clé ou une période de coexistence avec une version antérieure, toute reprise nécessite une réconciliation explicite avec le courtier. L’autorisation Redis ne peut pas annuler une requête déjà autorisée ou transmise. La suite locale exerce le script Lua avec un Redis simulé et le transport avec un courtier simulé.
