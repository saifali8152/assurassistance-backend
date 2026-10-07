# Mobile money payments — what we need from you, and how to get it

**Assur'Assistance — WhatsApp purchase platform**

---

## What this is about

Your customers can now buy a policy entirely inside WhatsApp. The last step of
that conversation is payment: the customer chooses their operator, confirms on
their phone, and the policy and certificate are issued automatically.

For that to work, each mobile money operator you want to accept has to open a
**merchant account** for Assur'Assistance and issue you **API credentials** — a
set of identifiers and secret keys that let our platform ask the operator to
charge a customer, and let the operator tell us when the customer has paid.

You do this once per operator. You can start with one and add the others later —
the platform offers the customer only the operators that are switched on.

**This is mostly a commercial process, not a technical one.** Each operator will
ask for your company documents and will assign you an account manager. The
technical credentials come at the end, usually by email from that person.

---

## First, the good news about security

**You enter these credentials yourself. You never have to send them to anyone,
including us.**

In your admin panel: **System → Payment Settings**. Each operator has its own
section. The secret fields are encrypted the moment you save them, and from then
on the screen shows them masked (`••••••••-key`) — not even an administrator can
read them back. If you paste a secret and the platform cannot encrypt it, it
**refuses to save** rather than storing it in readable form.

So the ideal flow is: the operator emails you the credentials, you open the admin
panel, you paste them in, you delete the email.

If you would rather we help you enter them on a screen share, that is fine. What
we would ask you to avoid is sending a live secret key over WhatsApp or plain
email, because those copies are then permanent and outside your control.

---

## What every operator has to give you

These are the boxes in **System → Payment Settings**. Not every operator uses
every one — leave a box empty if your operator does not issue that item.

| What the box is called | In plain words | Secret? |
|---|---|---|
| **API base URL** | The web address of the operator's payment service. They will give you two: one for testing, one for live. | No |
| **Merchant ID** | Your merchant or collection account number with that operator. | No |
| **API user / client ID** | The username-equivalent of the credential pair. | No |
| **API key / client secret** | The password-equivalent. This is the one that must never be shared loosely. | **Yes** |
| **Subscription key** | An extra key some operators issue per application (MTN does; Wave does not). | **Yes** |
| **Callback secret** | A shared secret the operator uses to sign the messages it sends us, so we can prove a "payment received" message really came from them and not from someone pretending. | **Yes** |
| **Settlement account** | The account your money arrives in. We only use it on reports, so you can reconcile. | No |

Three more boxes we fill in for you, so you can ignore them: the name the
customer sees in the chat, the countries the operator covers, and the valid phone
number prefixes.

**If an operator uses different words than the table above** — and they all do —
send us the list exactly as they wrote it and we will tell you which box each
item goes in. That is a two-minute job for us and guesswork for you.

---

## The address each operator must call back

Every operator needs to know where to tell us a payment succeeded or failed.
Give each operator **only its own address**:

| Operator | Address to register |
|---|---|
| Orange Money | `https://<your-api-domain>/api/payments/webhook/orange` |
| MTN MoMo | `https://<your-api-domain>/api/payments/webhook/mtn` |
| Wave | `https://<your-api-domain>/api/payments/webhook/wave` |
| Moov Money | `https://<your-api-domain>/api/payments/webhook/moov` |

We will send you the exact domain to use in place of `<your-api-domain>`. These
addresses must be registered with the operator, otherwise payments will be taken
and the policy will not be issued — the money arrives at the operator, but
nothing tells our platform.

---

## Operator by operator

### 1. Orange Money (Côte d'Ivoire)

Orange's product for this is **Orange Money Web Payment**, and Côte d'Ivoire is
one of the supported countries.

**Steps**

1. **Get an Orange Money merchant account.** Go through Orange Côte d'Ivoire's
   business channel (your Orange business contact, or an Orange shop that handles
   business accounts). Ask specifically for a *compte marchand Orange Money* with
   **online / API collection** enabled — a shop till account is not the same
   thing. They will ask for the company registration documents and the legal
   representative's ID.
2. **Create a developer account** at `developer.orange.com`, create an
   application there, and subscribe it to the **Orange Money Web Payment** API.
   This gives you test access.
3. **Request production access** for that application. Orange issues the live
   credentials — a merchant key plus a client ID and client secret for the
   application.
4. **Give Orange the callback address** from the table above.
5. Ask them to confirm, in writing, the **live base URL** — it differs from the
   test one.

**What to ask for, in one sentence:** *"We need production Orange Money Web
Payment credentials for Côte d'Ivoire: merchant key, client ID, client secret,
the production base URL, and please register our notification URL."*

---

### 2. MTN MoMo (Côte d'Ivoire)

MTN runs a self-service developer portal, which makes this the most
straightforward of the four to start — though production access still needs MTN
Côte d'Ivoire to approve it.

**Steps**

1. **Get an MTN MoMo merchant / collection account** from MTN Côte d'Ivoire's
   business channel. Again: a collection account for a business, not a personal
   wallet.
2. **Register at `momodeveloper.mtn.com`.** Subscribe to the **Collections**
   product — the portal also calls it **"Get Paid"**. Subscribing gives you a
   **subscription key** straight away.
3. **Test in the sandbox.** The portal lets you generate a test API user and API
   key yourself. Nothing is needed from us for this step; it only proves the
   account works.
4. **Apply for production access** through the portal, and chase it with your MTN
   Côte d'Ivoire account manager — this is the step that takes time. You will
   receive a production subscription key, an API user and an API key.
5. Ask them for the **target environment name** for Côte d'Ivoire (a short code
   that identifies the live environment) and the **production base URL**, and
   **register the callback address** from the table above.

**What to ask for, in one sentence:** *"We need production access to the MoMo
Collections API for Côte d'Ivoire: production subscription key, API user, API
key, the target environment name and the production base URL, and please whitelist
our callback URL."*

---

### 3. Wave (Côte d'Ivoire)

Wave is the most self-service of the four: once your business account exists, you
can issue the key yourself in minutes.

**Steps**

1. **Open a Wave Business account** for Assur'Assistance and make sure your own
   user on it is an **admin** — only admins can see the developer area.
2. Sign in to the **Wave Business portal** (`business.wave.com`) and open the
   **developer section**.
3. **Create an API key.** Wave shows the full key **once only**, at the moment of
   creation. Copy it straight into the admin panel, or into a password manager —
   if you lose it you have to create a new one.
4. **Configure the webhook** with the callback address from the table above, and
   note the **webhook secret** Wave gives you — that goes in the *callback secret*
   box.

**What to ask for:** nothing, if you have an admin login. If you cannot see the
developer section, you are not an admin on the business account — that is what to
ask Wave support to fix.

---

### 4. Moov Money (Côte d'Ivoire)

Moov has no public self-service developer portal, so this one is entirely a
conversation with people.

**Steps**

1. Contact **Moov Africa Côte d'Ivoire's enterprise / Moov Money merchant
   team** — through your Moov business contact, or the enterprise line on
   `moov-africa.ci`.
2. Ask for a **Moov Money merchant account with API collection** (*API marchand /
   API de collecte*), and for their **integration documentation** plus **test
   credentials**.
3. They will send a contract and a document pack to complete. The technical
   credentials follow once that is signed.
4. **Give them the callback address** from the table above, and ask them to
   confirm the live base URL.

**What to ask for, in one sentence:** *"We want to accept Moov Money payments
online for an insurance product. Please send us the Moov Money merchant API
documentation, the onboarding requirements, and test credentials."*

**Realistic expectation:** this is usually the slowest of the four. If you want
to launch sooner, start with Wave and Orange Money and add Moov when it is ready
— the platform does not care how many operators are switched on.

---

## Questions to settle with each operator while you are talking to them

These are not technical, but they decide whether the whole thing works for your
business, and they are much easier to ask during onboarding than afterwards:

- **Commission per transaction** — a flat fee, a percentage, or both? Who pays
  it, you or the customer?
- **Settlement delay** — how long between the customer paying and the money being
  usable in your account?
- **Transaction limits** — minimum and maximum per transaction, and any daily
  cap. Compare these with your actual premiums; a plan that costs more than the
  per-transaction ceiling simply cannot be sold this way.
- **Refunds** — can you reverse a transaction through the API, through the portal,
  or only by calling someone? This matters the first time a customer pays twice.
- **Currency** — confirm XOF, and confirm whether they expect the amount in
  francs or in centimes. Getting this wrong by a factor of 100 is the single most
  common integration mistake.
- **Who do we call at 9pm** when payments stop working? Get a name and a number,
  not a general support address.

Please send us the answers to the currency question and the transaction limits
even before the credentials — they affect how the platform is configured.

---

## Checklist

Per operator, you are done when all of these are true:

- [ ] Merchant / collection account open, in the company's name
- [ ] Production credentials received from the operator
- [ ] Credentials entered in **System → Payment Settings** and saved
- [ ] Callback address registered with the operator
- [ ] Production base URL confirmed in writing
- [ ] Commission, settlement delay and transaction limits known
- [ ] One real test payment completed and the certificate received in WhatsApp

That last line is the one that actually proves it. We will walk through it with
you: one small real payment per operator, watched live, before you announce the
service to customers.

---

## What happens on our side once you have them

Nothing you need to do. When you save the credentials, the operator appears in
the WhatsApp conversation as a payment option for customers in the countries it
covers. If you switch it off again, it disappears and the conversation falls back
to an adviser calling the customer. No deployment, no downtime.

---

*Questions on any of this — send them over. If an operator gives you a list of
credentials whose names do not match the table above, forward the list as they
wrote it and we will map it for you.*
