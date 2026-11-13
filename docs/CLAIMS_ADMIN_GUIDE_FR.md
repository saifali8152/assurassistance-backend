# Sinistres et administration — guide d'utilisation

Pour l'équipe Assur'Assistance qui utilise le panneau d'administration : traiter
les sinistres, activer les sinistres, numéros de test, catégories, paramètres,
rôles, polices importées et simulateur WhatsApp. (Version anglaise :
`CLAIMS_ADMIN_GUIDE_EN.md`.)

---

## Avant d'activer les sinistres — la liste de l'administrateur

L'administrateur principal règle ces points dans le panneau. Chacun a une valeur par
défaut sûre — rien ne casse si l'un est oublié — mais ces valeurs ne conviennent pas
une fois que les clients déclarent.

| # | Quoi | Où | Par défaut |
|---|---|---|---|
| 1 | **Qui reçoit un e-mail pour chaque nouveau sinistre** — une personne, une boîte partagée ou plusieurs adresses | Paramètres des sinistres → *Envoyer les nouveaux sinistres à* | Personne ; les sinistres n'apparaissent que dans le panneau |
| 2 | **Catégories et justificatifs obligatoires** — à aligner sur vos produits et sur ce que votre assureur exige comme preuves | Catégories et justificatifs | Un jeu standard d'assurance voyage |
| 3 | **Durée de conservation des justificatifs** après clôture (selon vos obligations légales et celles de l'assureur) | Paramètres des sinistres → *Conserver les justificatifs après clôture (jours)* | Conservés indéfiniment |
| 4 | **Qui traite les sinistres** — donnez à ces personnes le rôle *Claims handler* (ou un rôle personnalisé) | Rôles et permissions → *Qui a quoi* | Seul l'administrateur principal voit les sinistres |
| 5 | Tester un sinistre de bout en bout avec le **simulateur** (et un numéro de test quand WhatsApp sera connecté) | Simulateur WhatsApp · Activation et numéros de test | — |

Ensuite **Activation et numéros de test → Activer** (§3).

---

## 1. Comment un client déclare un sinistre

Sur WhatsApp, le client écrit **SINISTRE** (ou choisit *Déclarer un sinistre* dans
le menu), puis :

1. donne son **numéro de police** (ou de certificat) et son **numéro de passeport
   / pièce d'identité** — les deux doivent correspondre à la même police ;
2. confirme la police affichée ;
3. choisit une **catégorie** et une **sous-catégorie** (ex. Voyage → Vol d'effets
   personnels) ;
4. indique la **date**, le **pays** et la **ville** de l'incident, puis répond aux
   questions propres à la catégorie ;
5. décrit ce qui s'est passé avec ses mots ;
6. envoie ses **justificatifs** — photos (JPG, PNG) ou PDF, un par message — et
   écrit **TERMINÉ** (ou *Plus tard* s'il ne les a pas encore) ;
7. relit le résumé et touche **Envoyer**.

Il reçoit une référence, par exemple **SIN-2026-000123**. Plus tard, **SUIVI
SIN-2026-000123** lui donne le statut du dossier.

Après plusieurs couples police/passeport erronés, le numéro est bloqué pendant un
temps (Paramètres des sinistres). Une déclaration inachevée est conservée et
proposée au client à son retour ; après 48 heures sans activité, elle est marquée
*abandonnée*.

---

## 2. Traiter les sinistres — *Sinistres*

Menu **Sinistres → Sinistres**.

- Les tuiles en haut comptent les sinistres **urgents en cours**, **déclarés**,
  **en instruction**, **clôturés** et **de test**. Cliquez sur une tuile pour filtrer.
- **Filtres** : recherche (référence, police, nom ou 4 derniers chiffres du
  téléphone), statut, priorité, catégorie, période, et **Inclure les sinistres de
  test**. Chaque filtre actif apparaît sous le panneau ; cliquez sur son × pour
  le retirer, ou sur **Effacer les filtres**.
- Les sinistres **urgents** en cours sont toujours en tête. Un sinistre est urgent
  quand la description contient des mots urgents (hôpital, urgence… ; modifiables
  dans les paramètres).
- Des badges signalent ce qui demande attention : **Mots urgents**,
  **Justificatifs manquants** (le client a choisi *Plus tard* pour un justificatif
  obligatoire — contactez-le), **Police impayée**, **Police expirée depuis…**,
  **Absent du produit** (acceptés mais signalés, selon les Paramètres des sinistres).
- Les numéros de téléphone sont masqués dans la liste ; la fiche les affiche en entier.

### La fiche d'un sinistre

- **Incident** — date, lieu, réponses propres à la catégorie et description dans
  les mots du client.
- **Justificatifs** — **Voir** ouvre le fichier dans la page (PDF ou image) ;
  **Télécharger** l'enregistre. Chaque consultation et téléchargement est enregistré
  à votre nom.
- **Client** — nom, numéro WhatsApp, langue, et **Ouvrir la conversation
  WhatsApp** (la conversation complète ; les fichiers envoyés s'y ouvrent aussi).
- **Police** — le numéro, son origine (vendue sur la plateforme ou importée) et la
  police telle qu'elle était au moment de la déclaration.
- **Historique des statuts** — chaque changement, qui l'a fait et sa note.

### Changer le statut

**Passer en instruction** → *En instruction*, puis **Clôturer le sinistre** →
*Clôturé*. Chaque changement propose une **note interne** facultative. Un
sinistre clôturé ne peut pas être rouvert. Le client voit le nouveau statut quand
il envoie **SUIVI** avec la référence.

L'équipe sinistres reçoit aussi un e-mail pour chaque nouveau sinistre (urgents
d'abord) — adresses dans Paramètres des sinistres.

---

## 3. Activer et désactiver — *Activation et numéros de test*

Les sinistres sont **désactivés** à la livraison. Pendant ce temps, un client qui
écrit SINISTRE reçoit un message neutre (« bientôt disponible ») ; seuls les
**numéros de test** et le **simulateur** peuvent déclarer, et ce sont des
**sinistres de test** (masqués de la liste normale).

- **Activer** : cliquez sur **Activer**, lisez les effets, tapez **ACTIVER** et
  confirmez. Effet immédiat pour tous les clients.
- **Désactiver** : même chose avec **DÉSACTIVER**. Les sinistres déjà déclarés
  restent et peuvent toujours être traités.
- L'**Historique** enregistre chaque bascule et chaque changement de numéro de
  test, avec le nom de la personne.

### Numéros de test

Ajoutez un numéro WhatsApp avec l'indicatif pays (ex. *+225 07 11 22 33 44*) et à
qui il appartient. Ce téléphone peut déclarer même quand les sinistres sont
désactivés. Retirez les testeurs après la mise en service.

---

## 4. Catégories et justificatifs

Menu **Sinistres → Catégories et justificatifs**. Ce que le client choisit sur
WhatsApp.

- Chaque **catégorie** (Voyage, Médical…) a des **sous-catégories**.
- Pour chaque sous-catégorie : libellés français et anglais, **justificatifs
  obligatoires** et **facultatifs**, **questions** supplémentaires (texte, nombre
  avec min/max, date ou liste de choix), et une **priorité** (normale / haute /
  urgente).
- **Masquer** retire une catégorie de WhatsApp sans la perdre — les sinistres
  déjà déclarés gardent leur libellé.
- **Nouvelle catégorie** / **Sous-catégorie** pour ajouter ; **Modifier** pour changer.

---

## 5. Paramètres des sinistres

Menu **Sinistres → Paramètres des sinistres**. Chaque changement est marqué
*modifié* ; **Enregistrer** les enregistre tous (et les inscrit au journal
d'audit) ; **Annuler les modifications** revient en arrière.

| Paramètre | Rôle |
|---|---|
| Format de la référence | ex. `SIN-{YYYY}-{SEQ:6}` |
| Description la plus courte / la plus longue | En dessous, le client est invité à détailler ; au-dessus, à raccourcir |
| Déclarations inachevées abandonnées après | En heures (48 par défaut) |
| Numéro de carte d'assistance | Si le client peut s'identifier avec un numéro de carte distinct |
| Échecs de vérification permis / blocage | Couples police/passeport erronés avant blocage du numéro, et durée |
| Expiration, jours pour déclarer, polices impayées, type absent du produit | Quelles polices peuvent déclarer, jusqu'à quand ; accepter en signalant ou refuser |
| Nombre maximal de justificatifs, fichier le plus lourd | Par sinistre |
| Conserver les justificatifs après clôture (jours) | Vide = conservés indéfiniment. Sinon, les fichiers des sinistres clôturés ou abandonnés depuis plus longtemps sont supprimés (le sinistre et la trace de chaque fichier restent) |
| Envoyer les nouveaux sinistres à | Destinataires des e-mails |
| Mots urgents (français / anglais) | Mots qui rendent un sinistre urgent |
| Déclaration à accepter, étapes suivantes (FR/EN) | Textes lus par le client |

---

## 6. Rôles et permissions

Menu **Personnes et partenaires → Rôles et permissions** (administrateur principal
uniquement).

- Les rôles existants (sous-administrateur, superviseur assureur, agent)
  **gardent exactement leurs droits**. Les permissions ici n'ouvrent que les
  nouveaux écrans.
- **Claims handler** (gestionnaire sinistres — rôle prêt à l'emploi, que vous
  pouvez renommer) : voir les sinistres, changer
  leur statut, ouvrir les justificatifs. Pas de paramètres, d'activation, de rôles,
  d'import ni de simulateur.
- **Nouveau rôle** : nommez-le et cochez les permissions — voir les sinistres,
  changer le statut, ouvrir les justificatifs, paramètres, catégories,
  activer/désactiver, numéros de test, importer des polices, simulateur WhatsApp.
- **Qui a quoi** : choisissez un rôle pour chaque membre de l'équipe. Son menu se
  met à jour au prochain chargement de page.
- **Journal d'audit** : chaque changement de rôle, consultation de sinistre ou de
  justificatif, changement de statut, de paramètre ou d'activation, avec la
  personne et l'heure.

Le panneau déconnecte un utilisateur après **30 minutes** sans activité (un
avertissement apparaît une minute avant). Après **5 mots de passe erronés**, un
compte est bloqué **15 minutes**.

---

## 7. Polices importées

Menu **Opérations → Polices importées**. Pour les polices vendues **hors** de la
plateforme, afin que leurs titulaires puissent déclarer un sinistre. Elles
n'apparaissent jamais dans les ventes, registres, factures ou commissions.

- **Importer un fichier** — CSV ou Excel, jusqu'à 5 000 lignes, dates au format
  JJ/MM/AAAA. **Télécharger le modèle (CSV)** pour les colonnes. Le fichier est
  d'abord vérifié : l'aperçu montre les lignes valides et chaque erreur avec son
  numéro de ligne. Seules les lignes valides sont importées. Les colonnes inconnues
  sont listées et ignorées.
- **Ajouter une police** — une seule police, à la main.
- Cochez **Police de test** pour les polices servant uniquement aux tests.
- Recherche par numéro de police ou de carte, par nom, ou par numéro de passeport
  **exact** (les passeports sont chiffrés : pas de recherche partielle).
- **Annuler la police** pour empêcher de nouvelles déclarations dessus.

---

## 8. Simulateur WhatsApp

Menu **Système → Simulateur WhatsApp**. Parlez au véritable assistant WhatsApp
depuis le panneau — mêmes questions, mêmes règles.

- **Rien n'est envoyé sur WhatsApp**, aucun paiement ne démarre, aucun dossier ni
  police n'est créé.
- Les sinistres déclarés ici sont des **sinistres de test** (Sinistres → *Inclure
  les sinistres de test*), même quand les sinistres sont désactivés.
- Chaque membre de l'équipe a son propre numéro de test : plusieurs personnes
  peuvent tester en même temps.
- **Recommencer** ferme la conversation ; le choix de langue s'applique à la suivante.
- Pour tester un sinistre, utilisez un vrai numéro de police avec son passeport —
  ou importez d'abord une **police de test**.

---

## 9. Dépannage

| Situation | Que faire |
|---|---|
| Un membre de l'équipe voit « non autorisé » sur une page sinistres | Donnez-lui un rôle avec cette permission (Rôles et permissions → Qui a quoi) |
| Un justificatif est *en attente* | Le téléchargement depuis WhatsApp a échoué brièvement ; il est relancé automatiquement pendant quelques heures. S'il finit *en échec*, contactez le client pour obtenir le document |
| Un sinistre affiche **Justificatifs manquants** | Le client a choisi *Plus tard* pour un justificatif obligatoire. On lui a annoncé qu'un agent le contacterait : contactez-le |
| Un client dit être « bloqué » | Trop de couples police/passeport erronés. Le blocage se lève seul après la durée réglée (Paramètres des sinistres) |
| Un client ne trouve pas sa police | Vérifiez le numéro et le passeport ; pour une police vendue hors plateforme, importez-la d'abord |
| Aucun e-mail de sinistre | Vérifiez Paramètres des sinistres → Envoyer les nouveaux sinistres à ; sinon, la configuration e-mail du serveur (équipe technique) |
| Un sinistre de test n'apparaît pas | Activez **Inclure les sinistres de test** |
| Il faut arrêter les sinistres tout de suite | Activation → **Désactiver** (tapez DÉSACTIVER). Rien n'est perdu |
| Un compte de l'équipe est bloqué | Il se débloque après 15 minutes |
