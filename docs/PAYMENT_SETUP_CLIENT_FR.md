# Paiement mobile money — ce dont nous avons besoin, et comment l'obtenir

**Assur'Assistance — plateforme d'achat par WhatsApp**

---

## De quoi s'agit-il

Vos clients peuvent désormais souscrire une police entièrement depuis WhatsApp.
La dernière étape de la conversation est le paiement : le client choisit son
opérateur, confirme sur son téléphone, et la police ainsi que l'attestation sont
émises automatiquement.

Pour que cela fonctionne, chaque opérateur de mobile money que vous souhaitez
accepter doit ouvrir un **compte marchand** au nom d'Assur'Assistance et vous
délivrer des **identifiants API** — un ensemble d'identifiants et de clés
secrètes qui permettent à notre plateforme de demander à l'opérateur de débiter
un client, et à l'opérateur de nous signaler que le client a payé.

Cette démarche se fait une fois par opérateur. Vous pouvez commencer avec un seul
et ajouter les autres plus tard : la plateforme ne propose au client que les
opérateurs qui sont activés.

**Il s'agit avant tout d'une démarche commerciale, pas technique.** Chaque
opérateur vous demandera les documents de la société et vous attribuera un
chargé de compte. Les identifiants techniques arrivent à la fin, généralement par
courriel de cette personne.

---

## D'abord, une bonne nouvelle côté sécurité

**C'est vous qui saisissez ces identifiants. Vous n'avez à les envoyer à
personne, pas même à nous.**

Dans votre panneau d'administration : **Système → Paramètres de paiement**.
Chaque opérateur y a sa propre section. Les champs secrets sont chiffrés dès
l'enregistrement et, à partir de ce moment, l'écran ne les affiche plus que
masqués (`••••••••-key`) — même un administrateur ne peut plus les relire. Si
vous collez un secret et que la plateforme ne parvient pas à le chiffrer, elle
**refuse d'enregistrer** plutôt que de le conserver en clair.

Le déroulement idéal est donc : l'opérateur vous envoie les identifiants par
courriel, vous ouvrez le panneau d'administration, vous les collez, vous
supprimez le courriel.

Si vous préférez que nous vous accompagnions par partage d'écran, c'est tout à
fait possible. Ce que nous vous demandons d'éviter, c'est d'envoyer une clé
secrète active par WhatsApp ou par courriel ordinaire : ces copies deviennent
permanentes et échappent à votre contrôle.

---

## Ce que chaque opérateur doit vous fournir

Voici les champs de **Système → Paramètres de paiement**. Tous les opérateurs
n'utilisent pas tous les champs — laissez vide celui que votre opérateur ne
délivre pas.

| Nom du champ | En clair | Secret ? |
|---|---|---|
| **URL de base de l'API** | L'adresse du service de paiement de l'opérateur. Ils vous en donneront deux : une pour les tests, une pour le réel. | Non |
| **Identifiant marchand** | Votre numéro de compte marchand ou de compte de collecte chez cet opérateur. | Non |
| **Utilisateur API / client ID** | L'équivalent du nom d'utilisateur dans le couple d'identifiants. | Non |
| **Clé API / client secret** | L'équivalent du mot de passe. C'est celle qui ne doit jamais circuler librement. | **Oui** |
| **Clé d'abonnement** | Une clé supplémentaire que certains opérateurs délivrent par application (MTN le fait ; Wave non). | **Oui** |
| **Secret de rappel** | Un secret partagé que l'opérateur utilise pour signer les messages qu'il nous envoie, afin que nous puissions prouver qu'un message « paiement reçu » vient bien de lui et non de quelqu'un qui se fait passer pour lui. | **Oui** |
| **Compte de règlement** | Le compte sur lequel votre argent arrive. Nous ne l'utilisons que dans les rapports, pour votre rapprochement. | Non |

Trois autres champs sont renseignés par nous, vous pouvez les ignorer : le nom
affiché au client dans la conversation, les pays couverts par l'opérateur et les
préfixes de numéros valides.

**Si un opérateur emploie d'autres termes que le tableau ci-dessus** — et ils le
font tous — transmettez-nous la liste telle qu'ils l'ont rédigée et nous vous
indiquerons dans quel champ va chaque élément. C'est deux minutes de travail pour
nous et des suppositions pour vous.

---

## L'adresse que chaque opérateur doit rappeler

Chaque opérateur doit savoir où nous signaler qu'un paiement a réussi ou échoué.
Communiquez à chaque opérateur **uniquement son adresse** :

| Opérateur | Adresse à enregistrer |
|---|---|
| Orange Money | `https://<votre-domaine-api>/api/payments/webhook/orange` |
| MTN MoMo | `https://<votre-domaine-api>/api/payments/webhook/mtn` |
| Wave | `https://<votre-domaine-api>/api/payments/webhook/wave` |
| Moov Money | `https://<votre-domaine-api>/api/payments/webhook/moov` |

Nous vous communiquerons le domaine exact à utiliser à la place de
`<votre-domaine-api>`. Ces adresses doivent impérativement être enregistrées
chez l'opérateur : sinon le paiement est encaissé et la police n'est pas émise —
l'argent arrive bien chez l'opérateur, mais rien n'en informe notre plateforme.

---

## Opérateur par opérateur

### 1. Orange Money (Côte d'Ivoire)

Le produit concerné chez Orange s'appelle **Orange Money Web Payment**, et la
Côte d'Ivoire fait partie des pays pris en charge.

**Démarches**

1. **Ouvrir un compte marchand Orange Money.** Passez par le canal entreprises
   d'Orange Côte d'Ivoire (votre interlocuteur Orange Business, ou une agence
   Orange qui traite les comptes professionnels). Demandez explicitement un
   *compte marchand Orange Money* avec **collecte en ligne / par API** activée —
   un compte de caisse en boutique n'est pas la même chose. Ils demanderont les
   documents d'immatriculation de la société et la pièce d'identité du
   représentant légal.
2. **Créer un compte développeur** sur `developer.orange.com`, y créer une
   application et l'abonner à l'API **Orange Money Web Payment**. Cela vous donne
   l'accès de test.
3. **Demander l'accès production** pour cette application. Orange délivre alors
   les identifiants réels : une clé marchand (*merchant key*) ainsi qu'un client
   ID et un client secret pour l'application.
4. **Communiquer à Orange l'adresse de rappel** du tableau ci-dessus.
5. Demander une **confirmation écrite de l'URL de base de production** : elle
   diffère de celle des tests.

**Ce qu'il faut demander, en une phrase :** « *Nous avons besoin des identifiants
de production Orange Money Web Payment pour la Côte d'Ivoire : merchant key,
client ID, client secret, l'URL de base de production, et merci d'enregistrer
notre URL de notification.* »

---

### 2. MTN MoMo (Côte d'Ivoire)

MTN met à disposition un portail développeur en libre-service, ce qui en fait le
plus simple des quatre pour démarrer — même si l'accès production doit toujours
être approuvé par MTN Côte d'Ivoire.

**Démarches**

1. **Ouvrir un compte marchand / de collecte MTN MoMo** auprès du canal
   entreprises de MTN Côte d'Ivoire. Là encore : un compte de collecte
   professionnel, pas un portefeuille personnel.
2. **S'inscrire sur `momodeveloper.mtn.com`.** Souscrire au produit
   **Collections** — le portail l'appelle aussi **« Get Paid »**. La souscription
   vous donne immédiatement une **clé d'abonnement**.
3. **Tester dans le bac à sable (sandbox).** Le portail vous permet de générer
   vous-même un utilisateur API et une clé API de test. Nous n'intervenons pas à
   cette étape ; elle sert uniquement à vérifier que le compte fonctionne.
4. **Demander l'accès production** via le portail, puis le relancer auprès de
   votre chargé de compte MTN Côte d'Ivoire — c'est cette étape qui prend du
   temps. Vous recevrez une clé d'abonnement de production, un utilisateur API et
   une clé API.
5. Leur demander le **nom de l'environnement cible** pour la Côte d'Ivoire (un
   code court qui identifie l'environnement réel) ainsi que l'**URL de base de
   production**, et **faire enregistrer l'adresse de rappel** du tableau
   ci-dessus.

**Ce qu'il faut demander, en une phrase :** « *Nous souhaitons l'accès production
à l'API MoMo Collections pour la Côte d'Ivoire : clé d'abonnement de production,
utilisateur API, clé API, nom de l'environnement cible et URL de base de
production, et merci d'autoriser notre URL de rappel.* »

---

### 3. Wave (Côte d'Ivoire)

Wave est le plus autonome des quatre : une fois le compte professionnel ouvert,
vous générez la clé vous-même en quelques minutes.

**Démarches**

1. **Ouvrir un compte Wave Business** pour Assur'Assistance et vérifier que
   votre propre utilisateur y est **administrateur** — seuls les administrateurs
   voient l'espace développeur.
2. Se connecter au **portail Wave Business** (`business.wave.com`) et ouvrir la
   **section développeur**.
3. **Créer une clé API.** Wave n'affiche la clé complète **qu'une seule fois**, au
   moment de la création. Copiez-la directement dans le panneau
   d'administration, ou dans un gestionnaire de mots de passe — si vous la
   perdez, il faut en créer une nouvelle.
4. **Configurer le webhook** avec l'adresse de rappel du tableau ci-dessus, et
   noter le **secret du webhook** fourni par Wave : il va dans le champ *secret de
   rappel*.

**Ce qu'il faut demander :** rien, si vous disposez d'un accès administrateur. Si
vous ne voyez pas la section développeur, c'est que vous n'êtes pas
administrateur du compte professionnel — et c'est cela qu'il faut demander au
support Wave de corriger.

---

### 4. Moov Money (Côte d'Ivoire)

Moov n'a pas de portail développeur public en libre-service : tout se fait par
échange avec des interlocuteurs.

**Démarches**

1. Contacter l'**équipe entreprises / marchands Moov Money de Moov Africa Côte
   d'Ivoire** — via votre interlocuteur Moov Business, ou la ligne entreprises
   sur `moov-africa.ci`.
2. Demander un **compte marchand Moov Money avec collecte par API** (*API
   marchand / API de collecte*), ainsi que leur **documentation d'intégration** et
   des **identifiants de test**.
3. Ils enverront un contrat et un dossier à compléter. Les identifiants
   techniques suivent une fois la signature obtenue.
4. **Leur communiquer l'adresse de rappel** du tableau ci-dessus et demander
   confirmation de l'URL de base réelle.

**Ce qu'il faut demander, en une phrase :** « *Nous souhaitons accepter les
paiements Moov Money en ligne pour un produit d'assurance. Merci de nous
transmettre la documentation de l'API marchand Moov Money, les conditions
d'ouverture et des identifiants de test.* »

**Attente réaliste :** c'est généralement le plus lent des quatre. Si vous
souhaitez démarrer plus vite, commencez par Wave et Orange Money et ajoutez Moov
lorsqu'il sera prêt — le nombre d'opérateurs activés est indifférent à la
plateforme.

---

## Questions à régler avec chaque opérateur pendant les échanges

Ces points ne sont pas techniques, mais ils déterminent si l'ensemble est viable
pour votre activité, et il est bien plus simple de les poser pendant l'ouverture
du compte qu'après :

- **Commission par transaction** — montant fixe, pourcentage, ou les deux ? À la
  charge de qui, vous ou le client ?
- **Délai de règlement** — combien de temps entre le paiement du client et la
  disponibilité des fonds sur votre compte ?
- **Plafonds de transaction** — minimum et maximum par transaction, et plafond
  journalier éventuel. Comparez-les à vos primes réelles : une formule dont le
  prix dépasse le plafond par transaction ne pourra tout simplement pas être
  vendue par ce canal.
- **Remboursements** — pouvez-vous annuler une transaction par l'API, par le
  portail, ou uniquement en appelant quelqu'un ? Cela compte dès la première fois
  qu'un client paie deux fois.
- **Devise** — confirmer le XOF, et confirmer s'ils attendent le montant en
  francs ou en centimes. Se tromper d'un facteur 100 est l'erreur d'intégration
  la plus fréquente.
- **Qui appeler à 21 h** quand les paiements ne passent plus ? Obtenez un nom et
  un numéro, pas une adresse de support générique.

Merci de nous transmettre les réponses sur la devise et sur les plafonds **avant
même** les identifiants : elles conditionnent le paramétrage de la plateforme.

---

## Liste de vérification

Pour chaque opérateur, c'est terminé lorsque tous ces points sont vrais :

- [ ] Compte marchand / de collecte ouvert, au nom de la société
- [ ] Identifiants de production reçus de l'opérateur
- [ ] Identifiants saisis et enregistrés dans **Système → Paramètres de paiement**
- [ ] Adresse de rappel enregistrée chez l'opérateur
- [ ] URL de base de production confirmée par écrit
- [ ] Commission, délai de règlement et plafonds de transaction connus
- [ ] Un vrai paiement de test effectué et l'attestation reçue dans WhatsApp

C'est cette dernière ligne qui fait réellement la preuve. Nous la réaliserons
avec vous : un petit paiement réel par opérateur, suivi en direct, avant
d'annoncer le service à vos clients.

---

## Ce qui se passe de notre côté une fois les identifiants en place

Rien à faire de votre part. Dès l'enregistrement des identifiants, l'opérateur
apparaît comme moyen de paiement dans la conversation WhatsApp, pour les clients
des pays qu'il couvre. Si vous le désactivez, il disparaît et la conversation
revient au rappel par un conseiller. Aucun déploiement, aucune interruption de
service.

---

*Pour toute question, écrivez-nous. Si un opérateur vous transmet une liste
d'identifiants dont les noms ne correspondent pas au tableau ci-dessus,
transmettez-la telle quelle et nous ferons la correspondance pour vous.*
