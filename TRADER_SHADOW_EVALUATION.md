# Évaluation chronologique de la stratégie traders en SHADOW

## Intégration vérifiée

`main` examiné : `eac52058adab7dc51505f9bb52f19bc7e3e0fa40`. Les PR #71 (comptabilité SHADOW) et #72 (expositions) sont effectivement fusionnées. La PR #77 (politique consultative) est ouverte et non fusionnée : la branche d'évaluation inclut son code et conserve ses tests. Aucune fusion dans main n'est effectuée par ce travail.

Le raccordement se trouve dans `scanMarket`, après l'analyse réelle de LEO et son `riskController`, avant l'exécution. Il réutilise la décision brute, la décision finale, les données de marché et le portefeuille déjà lus pour ce scan. Aucun second appel IA, appel eToro ou rafraîchissement d'observateur n'est ajouté. Hors SHADOW, l'expérience ne s'exécute pas.

En SHADOW, le répartiteur final appelle directement le moteur virtuel pour BUY et SELL, sans passer par un exécuteur capable de joindre le broker. Aucun chemin de copie n'est introduit. Les fonctions d'exécution LIVE et leurs autorisations restent inchangées.

## Expérience jumelée

Deux portefeuilles commencent avec le même état virtuel figé : `strategy` applique les contrôles de la politique traders ; `baseline` retire seulement les contrôles spécifiques aux sources traders. Les deux conservent les mêmes exigences de risque LEO, cours, coûts, éligibilité, liquidités et exposition. Une donnée commune inconnue bloque les deux. Les unités, les valeurs et les limites propres à chaque portefeuille sont recalculées séparément. Les renforts, réductions et sorties sont comptabilisés ; une réduction conserve la position virtuelle et son coût de revient proportionnel.

La référence partage les **idées de LEO et le contexte d'analyse/risque**. Elle n'appelle pas une deuxième IA avec un portefeuille différent et ne reconstruit pas indépendamment les rétroactions du conseil, des cooldowns ou de la sélection des instruments. C'est une comparaison conditionnelle de filtres sur des idées communes, pas une estimation causale d'alpha ni deux systèmes autonomes intégralement rejoués. Cette limite reste affichée même lorsque les critères descriptifs sont satisfaits.

Le capital de départ provient du portefeuille PAPER, distinct des avoirs réels. Un éventuel amorçage depuis le réel reste incomplet si ses positions, copies ou risques ne sont pas reconstitués. Les identifiants `shadow-*` désignent uniquement des positions virtuelles ; ils ne créent pas de lots ou d'identifiants de positions broker.

La sélection consultative antérieure peut être reprise au premier scan uniquement si son état et son historique ne sont pas futurs. L'expérience fait ensuite évoluer sa propre sélection avec la même politique figée ; une consultation manuelle ne réécrit pas une sélection expérimentale passée.

## Preuves figées et horloges

Chaque cycle possède un identifiant stable, un cutoff de décision finale et un enregistrement contenant :

- version et identifiant de politique, protocole et sélection des traders ;
- identifiants des observations sources et niveau de preuve « présence publique partielle, pas transaction » ;
- réception par LEO, fondée sur la fin de collecte ; publication réellement connue et date effective distinctes, sinon `null` ;
- proposition LEO, décision finale, code de risque et veto des deux portefeuilles ;
- éligibilité et coûts disponibles, sous-totaux d'exposition virtuelle et état de l'exposition réelle ;
- cours bid/ask/mid utilisé, date, réception, source, qualité, ordre virtuel et frais/glissement estimés ;
- compteurs d'appels supplémentaires et coût IA partagé lorsqu'il est observable.

Les champs de preuve conservés sont explicitement sélectionnés ; aucun en-tête, clé, jeton ou réponse réseau brute n'est enregistré. Les seuils et hypothèses sont conservés dans le protocole, pas reconstruits à partir de la configuration courante.

Les observations, cours et permissions reçus après le cutoff ne peuvent pas autoriser une simulation antérieure. Une publication ou date effective future est également exclue. Le cutoff correspond à la décision finale après les lectures et contrôles du scan ; il ne prétend pas dater une transaction du trader. Le prix de référence est celui connu à ce cutoff, pas un cours de transaction du trader.

Les enregistrements existants sont copiés et conservés sans réécriture lors des cycles suivants. Les corrections affectent uniquement les cycles ultérieurs. Un identifiant de cycle déjà traité ne provoque aucun nouvel ordre ; il n'est pas oublié pour libérer de la place. Un nouveau scan avec une nouvelle idée LEO peut réutiliser une même présence de portefeuille comme contexte : cela ne constitue pas une nouvelle transaction observée du trader.

## Protocole fixé avant résultats

Le premier scan enregistre le protocole avant toute simulation. Configuration optionnelle : `TRADER_SHADOW_PROTOCOL_JSON`, et politique `TRADER_ADVISORY_POLICY_JSON`. Aucune variable Render n'est modifiée ici. Toute modification ultérieure des paramètres ou hypothèses est refusée pour l'expérience en cours et signalée comme couverture incomplète ; elle nécessite une nouvelle expérience explicite, pas une réoptimisation en continu.

| Paramètre initial | Valeur | Usage |
| --- | --- | --- |
| designDays | 30 jours | Période de conception, jamais présentée comme hors échantillon |
| evaluationDays | 90 jours | Fenêtre chronologique d'évaluation séparée |
| minimumEvaluationDays | 60 jours observés | Durée minimale d'une comparaison descriptive dans cette fenêtre |
| minimumDecisions | 100 | Minimum de décisions appariées |
| minimumFullClosures | 20 par portefeuille | Une réduction ne compte pas comme une position entièrement clôturée |
| maxRecords | 120 | Journal de décisions retenu avant signalement de troncature |

Ces valeurs sont des conventions de recherche configurables et versionnées, pas des seuils optimaux démontrés. À la frontière conception/évaluation, les deux portefeuilles d'évaluation repartent du même état de départ figé, valorisé avec les cours alors disponibles. Les opérations de conception ne sont pas ajoutées au rendement d'évaluation. La visibilité des sources antérieure peut servir à la qualification sans ajuster les seuils sur leurs rendements d'évaluation.

Critères enregistrés : différence de rendement ajusté des flux, drawdown, volatilité, rotation/coûts, couverture et suffisance du nombre de décisions/clôtures. Le rapport ne produit une différence descriptive que si la fenêtre est hors conception, les minima sont satisfaits, au moins une décision diffère et les données/historiques nécessaires sont complets. Aucune significativité statistique n'est estimée ; dépendance des observations, petit échantillon et sélection des traders empêchent toute revendication de performance future.

## Comptabilité réutilisée

`paper-shadow-execution.js` est le moteur partagé entre les exécuteurs PAPER existants et les deux portefeuilles expérimentaux : bid/ask, glissement configuré, frais simulés, cash, unités, renforts, coût de revient, réductions, sorties et PnL. Il n'a aucun accès réseau. Le comportement existant continue de refuser un renfort sur une position déjà ouverte ; le laboratoire l'autorise seulement dans les limites consultatives vérifiées.

`paper-shadow-accounting.js` fournit le même scorecard : Modified Dietz lorsque flux et valorisations le permettent, rendement de prix du benchmark dans la même devise/fenêtre, drawdown et volatilité quotidiens ajustés, rotation, coûts et couverture. La volatilité utilise la convention d'annualisation existante ; une série quotidienne mixte actions/crypto n'est pas une série de rendements indépendants à intervalles économiques identiques.

Les valorisations expérimentales gardent la dernière observation de chaque jour UTC ; la valeur initiale est conservée séparément. Un cours absent/périmé conserve au mieux un ancien sous-total, mais rend la valorisation incomplète. Aucune conversion de devise ni dividende non documenté n'est ajouté.

Les dépôts/retraits du registre PAPER existant sont aussi soumis aux deux portefeuilles expérimentaux actifs, avec identifiant idempotent. Ils n'altèrent pas les enregistrements de décision. Une impossibilité de retrait dans l'un des deux, un flux tardif ou hors cohorte initialisée rend la couverture des flux incomplète : le rendement ajusté est indisponible plutôt que calculé avec un flux omis. Les flux antérieurs au démarrage sont déjà compris dans le capital initial. Les frais observés restent `null`, distincts des frais/glissements hypothétiques et des coûts inconnus.

Le module ajoute exactement zéro requête fournisseur, zéro appel IA et zéro appel d'exécution ; leurs coûts supplémentaires directs sont donc zéro pour ce chemin. Les résumés HTTP disponibles de l’observateur sont comptés une seule fois par canal et date, sans prétendre couvrir les réponses déjà perdues ou les collectes antérieures au protocole. Le coût de ces collectes en amont, leur attribution causale et le surcoût d’infrastructure restent inconnus. Les écritures de stockage utilisent le pipeline commun avec temporisation ; leur surcoût n’est pas attribué séparément. Le coût IA du scan commun, s'il est disponible, est partagé, pas compté deux fois.

## Limites et exploitation

`GET /trader-shadow-status` et `GET /trader-shadow-decisions` utilisent l'authentification existante et ne déclenchent ni collecte, ni scan, ni simulation. L'expérience utilise le stockage runtime/Upstash/local existant. Le journal, les ordres et les snapshots sont bornés. Les compteurs de décisions, différences, réductions et clôtures sont conservés séparément ; la rotation et les historiques retenus restent explicitement partiels si leurs lignes ont été tronquées.

La compaction vise 90 Ko pour cette section, 6 Ko en sauvegarde critique. Elle retire d'abord les preuves anciennes avec `historyTruncated`. Si les portefeuilles et les identifiants de déduplication ne tiennent plus, l'expérience se désactive avec `ARCHIVE_REQUIRED`, sans redémarrage automatique. Une étude exhaustive sur plusieurs mois nécessite donc un archivage supplémentaire explicitement autorisé ; cette branche n'invente pas un stockage illimité. Les cycles échoués ou refusés pour changement de protocole sont comptés comme trous de couverture.

Dans le runtime actuel, l'éligibilité n'est pas prouvée pour le même compte/sens/montant/produit, les coûts complets contextualisés ne sont pas raccordés et les compositions ne sont pas suffisamment couvertes. Ces inconnues bloquent les deux portefeuilles : une comparaison fiable demeure indisponible. Les tests avec preuves synthétiques complètes vérifient les calculs, sans établir de droits réels ou de résultats de marché.

## Vérification

`npm run test:trader-shadow`, `npm run check`, `npm test`, `git diff --check`, puis contrôles de préchargement et invariants BUY/SELL du workflow. Scénarios simulés : données tardives/futures, corrections, doublons, cours manquants, renforts, réductions et sorties complètes, flux et coûts inconnus, benchmark, fenêtres chronologiques et blocage réseau au dispatcher SHADOW réel. Aucun serveur ou collecteur n'est démarré pour ces tests ; les sauvegardes du test d'intégration sont interceptées.

Résultats de cette branche : 22 tests ciblés réussis ; suite complète 282/282 ; syntaxe, espacement, contrôles de préchargement et invariants du workflow réussis. Les fonctions broker et la commande start sont identiques à la version examinée. Aucune observation authentifiée, période de collecte réelle, durée de performance ou opération réelle n’a été mesurée ici. Aucun ordre, copie, changement LIVE/Render, fusion dans main ou déploiement effectué.
