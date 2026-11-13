# Claims & admin — user guide

For Assur'Assistance staff using the admin panel. Covers handling claims,
switching claims on, test numbers, categories, settings, roles, imported policies
and the WhatsApp simulator. (French version: `CLAIMS_ADMIN_GUIDE_FR.md`.)

---

## Before switching claims on — the administrator's checklist

The main administrator sets these in the panel. Each has a safe default, so nothing
breaks if one is left, but the defaults are not what you want once customers claim.

| # | What | Where | Default if left |
|---|---|---|---|
| 1 | **Who is emailed about new claims** — a person, a shared mailbox or several addresses | Claims settings → *Notification emails* | Nobody is emailed; claims only appear in the panel |
| 2 | **Categories and required documents** — match them to the products you sell and what your insurer requires as proof | Categories & documents | A standard travel-insurance set |
| 3 | **How long to keep documents** after a claim is closed (follow your legal / insurer retention rules) | Claims settings → *Document retention days* | Kept forever |
| 4 | **Who handles claims** — give those staff the *Claims handler* role (or a custom role) | Roles & permissions → *Who has what* | Only the main administrator sees claims |
| 5 | Test a claim end to end with the **simulator** (and a test number once WhatsApp is connected) | WhatsApp simulator · Activation & test numbers | — |

Then **Activation & test numbers → Switch on** (§3).

---

## 1. How a customer reports a claim

On WhatsApp the customer writes **SINISTRE** (or *CLAIM*), or picks *Report a
claim* from the menu, then:

1. gives their **policy number** (or certificate number) and their **passport /
   ID number** — both must match the same policy;
2. confirms the policy shown;
3. chooses a **category** and **sub-category** (e.g. Travel → Theft of belongings);
4. gives the **date**, **country** and **city** of the incident, then answers the
   category's extra questions;
5. describes what happened in their own words;
6. sends **documents** — photos (JPG, PNG) or PDFs, one per message — and writes
   **TERMINÉ** / *DONE*;
7. reviews the summary and taps **Envoyer** / *Submit*.

They receive a reference such as **SIN-2026-000123**. Later, **SUIVI
SIN-2026-000123** tells them the current status.

After several wrong policy/passport pairs, the number is locked out for a while
(Claims settings). An unfinished claim is kept and offered again when the
customer comes back; after 48 hours without activity it is marked *abandoned*.

---

## 2. Handling claims — *Claims*

Menu **Claims → Claims**.

- The tiles at the top count **urgent open**, **submitted**, **under review**,
  **closed** and **test** claims. Click a tile to filter.
- **Filters**: search (reference, policy, name or the last 4 digits of the phone),
  status, priority, category, a date range, and **Include test claims**. Each active
  filter shows as a chip under the panel; click its × to remove it, or **Clear
  filters**.
- **Urgent** open claims are always at the top. A claim is urgent when the
  description contains urgent words (hospital, emergency…; editable in settings).
- Badges flag what needs attention: **Urgent words**, **Documents missing** (the
  customer chose *Later* for a required document — contact them), **Policy
  unpaid**, **Policy expired since…**, **Not on the plan** (accepted but flagged,
  depending on Claims settings).
- Phone numbers are masked in the list; the detail page shows them in full.

### A claim's page

- **Incident** — date, place, the category's answers and the description in the
  customer's words.
- **Documents** — **View** opens the file in the page (PDF or image);
  **Download** saves it. Every view and download is recorded with your name.
- **Customer** — name, WhatsApp number, language, and **Open the WhatsApp
  conversation** (the full transcript; files sent there open from the transcript).
- **Policy** — the number, whether it was sold on the platform or imported, and
  the policy as it was at the time of the claim.
- **Status history** — every change, who made it and their note.

### Changing the status

**Start review** → *Under review*, then **Close the claim** → *Closed*. Each
change asks for an optional internal **note**. A closed claim cannot be reopened.
The customer sees the new status when they send **SUIVI** with the reference.

The claims team is also emailed about each new claim (urgent first) — addresses
in Claims settings.

---

## 3. Switching claims on and off — *Activation & test numbers*

Claims are **off** when delivered. While off, customers who write SINISTRE get a
neutral "coming soon"; only **test numbers** and the **simulator** can file claims,
and those are **test claims** (hidden from the normal list).

- **Switch on**: click **Switch on**, read the effects, type **ON** (in French:
  **ACTIVER**) and confirm. Immediate for every customer.
- **Switch off**: same with **OFF** (**DÉSACTIVER**). Submitted claims stay and can
  still be handled.
- The **History** column records every switch and test-number change with the
  person's name.

### Test numbers

Add a WhatsApp number with its country code (e.g. *+225 07 11 22 33 44*) and who
it belongs to. That phone can file claims while claims are off. Remove testers
after go-live.

---

## 4. Categories & documents

Menu **Claims → Categories & documents**. What the customer chooses on WhatsApp.

- Each **category** (Travel, Medical, …) has **sub-categories**.
- For each sub-category: the French and English labels, **required** and
  **optional documents**, extra **questions** (text, number with min/max, date or a
  choice list), and a **priority** (normal / high / urgent).
- **Hide** removes a category from WhatsApp without losing it — claims already
  made with it keep their label.
- **New category** / **Sub-category** to add; **Edit** to change.

---

## 5. Claims settings

Menu **Claims → Claims settings**. Each change shows *modified*; **Save** stores
them all and records them in the audit log; **Discard changes** undoes.

| Setting | What it controls |
|---|---|
| Claim reference format | e.g. `SIN-{YYYY}-{SEQ:6}` |
| Shortest / longest description | The customer is asked for more detail below, or to shorten above |
| Unfinished claims abandoned after | Hours (default 48) |
| Assistance card number | Whether customers may identify with a separate card number |
| Failed checks allowed / lockout | Wrong policy/passport pairs before a number is locked, and for how long |
| Expiry rule, filing window, unpaid policies | Which policies may claim, and until when |
| Max documents, max file size | Per claim |
| Document retention days | Empty = files kept forever. If set, files of claims closed or abandoned longer ago are removed (the claim and the record of each file stay) |
| Notification emails | Who is emailed about new claims |
| Urgent words (FR/EN) | Words that make a claim urgent |
| Consent and confirmation texts (FR/EN) | What the customer reads |

---

## 6. Roles & permissions

Menu **People & partners → Roles & permissions** (main administrator only).

- Existing roles (sub-administrator, insurer supervisor, agent) **keep exactly
  what they had**. The permissions here only open the new screens.
- **Claims handler** (ready-made role): see claims, change their status, open
  documents. No settings, activation, roles, imports or simulator.
- **New role**: name it and tick permissions — view claims, change status, open
  documents, claims settings, categories, switch on/off, test numbers, import
  policies, WhatsApp simulator.
- **Who has what**: choose a role for each staff member. Their menu updates on
  their next page load.
- **Audit log**: every role change, claim view, document view, status change,
  setting change and switch, with the person and time.

The panel signs a user out after **30 minutes** without activity (a warning appears
a minute before). After **5 wrong passwords** an account is locked for **15
minutes**.

---

## 7. Imported policies

Menu **Operations → Imported policies**. For policies sold **outside** the
platform, so their holders can report a claim. They never appear in sales,
ledgers, invoices or commissions.

- **Import a file** — CSV or Excel, up to 5,000 rows, dates as DD/MM/YYYY.
  **Download the template (CSV)** for the columns.
  The file is checked first: the preview shows valid rows and each error with its
  row number. Only valid rows are imported. Unknown columns are listed and ignored.
- **Add one** — a single policy by hand.
- Tick **Test policy** for policies used only for testing.
- Search by policy or card number, name, or the **exact** passport number
  (passports are stored encrypted, so partial search is not possible).
- **Cancel** a policy to stop new claims on it.

---

## 8. WhatsApp simulator

Menu **System → WhatsApp simulator**. Talk to the real WhatsApp assistant from
the admin panel — the same questions, the same rules.

- **Nothing is sent to WhatsApp**, no payment starts, no case or policy is created.
- Claims made here are **test claims** (Claims → *Include test claims*), even while
  claims are off.
- Each staff member has their own test number, so several people can test at once.
- **Start over** closes the conversation; the language toggle applies to the next
  one.
- To test a claim, use a real policy number with its passport — or import a
  **test policy** first.

---

## 9. Troubleshooting

| Situation | What to do |
|---|---|
| A staff member sees "unauthorized" on a claims page | Give them a role with that permission (Roles & permissions → Who has what) |
| A document says *pending* | The download from WhatsApp failed briefly; it is retried automatically for a few hours. If it ends *failed*, contact the customer for the document |
| A claim shows **Documents missing** | The customer chose *Later* for a required document. They were told an agent would ask for it: contact them |
| A customer says they are "locked" | Too many wrong policy/passport pairs. It clears by itself after the lockout time (Claims settings) |
| A customer cannot find their policy | Check the number and passport on the policy; for a policy sold outside the platform, import it first |
| No claim emails | Check Claims settings → notification emails; otherwise the server's email settings (technical team) |
| A test claim is missing from the list | Turn on **Include test claims** |
| Claims must stop now | Activation → **Switch off** (type OFF / DÉSACTIVER). Nothing is lost |
| A staff account is locked | It unlocks after 15 minutes |
