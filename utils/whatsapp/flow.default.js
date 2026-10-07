// src/utils/whatsapp/flow.default.js
//
// The purchase flow, expressed as DATA rather than control flow.
//
// WHY: the milestone's biggest schedule risk is the client asking for flow
// changes after the demo. If the order of questions, the prompts and the
// validation rules are data, most of those requests are an edit to this object
// (or to a row in `whatsapp_flows`) instead of a rewrite. The engine walks this
// definition and knows nothing about insurance.
//
// MESSAGE BUDGET — the milestone asked for 6–8 customer messages per purchase.
// Asking these fields one at a time costs thirteen before anything else, so three
// things are grouped or removed:
//   * `identity` collects last name, first name, date of birth AND passport in
//     one message (self-identifying tokens, so mis-assignment is detectable).
//   * `destination_dates` collects destination plus both travel dates together.
//   * country of residence defaults to nationality instead of being asked, and
//     stays editable from the review screen.
//   * the review screen IS the quote: it shows the premium with Confirm /
//     Change / Cancel, so confirming costs one tap, not two.
//
// Happy path, counting the message that OPENS the conversation (it costs the
// customer a message and is answered with the menu): greeting, menu tap,
// identity, gender, nationality, destination+dates, email, plan tap, confirm =
// 9 — and 8 when only one plan matches. Paying in the chat adds the operator
// choice and the number to charge, so the real budget is 8 to 11, which is what
// GET /whatsapp/stats reports. Above the target, and stated rather than rounded
// down.
//
// Each step:
//   key           unique id, stored on the session
//   type          text | buttons | list | dynamic_list | quote_review | terminal
//   promptKey     i18n key for the question
//   parser        name registered in the engine's PARSERS map
//   stores        session.collectedData fields this step writes
//   next          next step key, or a function of the collected data
//   fallback      steps to use when the retry limit is hit on a grouped step
//   editable      may be reached from the review screen's "change" list
//   editLabelKey  i18n key for its row in that list
//
export const DEFAULT_FLOW_KEY = "purchase";

export const FLOW = {
  key: DEFAULT_FLOW_KEY,
  version: 1,
  startStep: "welcome",
  steps: {
    welcome: {
      key: "welcome",
      type: "buttons",
      promptKey: "welcome.menu",
      greetingKey: "welcome.greeting",
      options: [
        { id: "menu:buy", labelKey: "welcome.optionBuy" },
        { id: "menu:question", labelKey: "welcome.optionQuestion" },
        { id: "cmd:agent", labelKey: "welcome.optionAgent" },
      ],
      parser: "menuChoice",
      next: "identity",
    },

    identity: {
      key: "identity",
      type: "text",
      promptKey: "step.personalInfo.prompt",
      parser: "groupedIdentity",
      stores: ["last_name", "first_name", "date_of_birth", "passport_or_id"],
      // When the passport was not included, ask for it on its own next.
      next: (data) => (data.passport_or_id ? "gender" : "passport"),
      fallback: ["identity_last_name", "identity_first_name", "identity_dob", "passport"],
    },

    // Reached only after repeated failures on the grouped step.
    identity_last_name: {
      key: "identity_last_name",
      type: "text",
      promptKey: "step.lastName.prompt",
      parser: "lastName",
      stores: ["last_name"],
      next: "identity_first_name",
      editable: true,
      editLabelKey: "review.lastName",
    },
    identity_first_name: {
      key: "identity_first_name",
      type: "text",
      promptKey: "step.firstName.prompt",
      parser: "firstName",
      stores: ["first_name"],
      next: "identity_dob",
      editable: true,
      editLabelKey: "review.firstName",
    },
    identity_dob: {
      key: "identity_dob",
      type: "text",
      promptKey: "step.dateOfBirth.prompt",
      parser: "dateOfBirth",
      stores: ["date_of_birth"],
      next: (data) => (data.passport_or_id ? "gender" : "passport"),
      editable: true,
      editLabelKey: "review.dateOfBirth",
    },

    passport: {
      key: "passport",
      type: "text",
      promptKey: "step.passport.prompt",
      parser: "passport",
      stores: ["passport_or_id"],
      next: "gender",
      editable: true,
      editLabelKey: "review.passport",
    },

    gender: {
      key: "gender",
      type: "buttons",
      promptKey: "step.gender.prompt",
      options: [
        { id: "gender:Male", labelKey: "step.gender.male" },
        { id: "gender:Female", labelKey: "step.gender.female" },
        { id: "gender:Other", labelKey: "step.gender.other" },
      ],
      parser: "gender",
      stores: ["gender"],
      next: "nationality",
      editable: true,
      editLabelKey: "review.gender",
    },

    nationality: {
      key: "nationality",
      type: "dynamic_list",
      promptKey: "step.nationality.prompt",
      listPromptKey: "step.nationality.listPrompt",
      listButtonKey: "step.nationality.listButton",
      candidatesKey: "step.nationality.candidates",
      notFoundKey: "step.nationality.notFound",
      parser: "country",
      source: "countries",
      stores: ["nationality", "nationality_code"],
      // Residence is defaulted from nationality by the engine, not asked.
      next: "destination_dates",
      editable: true,
      editLabelKey: "review.nationality",
    },

    residence: {
      key: "residence",
      type: "dynamic_list",
      promptKey: "step.residence.prompt",
      listPromptKey: "step.residence.listPrompt",
      listButtonKey: "step.residence.listButton",
      candidatesKey: "step.nationality.candidates",
      notFoundKey: "step.nationality.notFound",
      parser: "country",
      source: "countries",
      stores: ["country_of_residence", "residence_code"],
      next: "destination_dates",
      editable: true,
      editLabelKey: "review.residence",
    },

    destination_dates: {
      key: "destination_dates",
      type: "text",
      promptKey: "step.destination.prompt",
      datesPromptKey: "step.travelDates.prompt",
      listPromptKey: "step.destination.listPrompt",
      listButtonKey: "step.destination.listButton",
      candidatesKey: "step.destination.candidates",
      notFoundKey: "step.destination.notFound",
      parser: "destinationAndDates",
      source: "destinations",
      stores: ["destination", "destination_code", "start_date", "end_date", "stay_days"],
      next: (data) => (data.start_date && data.end_date ? "email" : "travel_dates"),
      editable: true,
      editLabelKey: "review.destination",
    },

    travel_dates: {
      key: "travel_dates",
      type: "text",
      promptKey: "step.travelDates.prompt",
      parser: "travelDates",
      stores: ["start_date", "end_date", "stay_days"],
      next: "email",
      editable: true,
      editLabelKey: "review.dates",
    },

    email: {
      key: "email",
      type: "text",
      promptKey: "step.email.prompt",
      parser: "email",
      stores: ["email"],
      next: "plan",
      editable: true,
      editLabelKey: "review.email",
    },

    // The phone number is taken from WhatsApp itself and only asked about when
    // the customer chooses to change it from the review screen.
    phone: {
      key: "phone",
      type: "text",
      promptKey: "step.phone.otherPrompt",
      parser: "phone",
      stores: ["phone"],
      next: "plan",
      editable: true,
      editLabelKey: "review.phone",
    },

    plan: {
      key: "plan",
      type: "dynamic_list",
      promptKey: "step.plan.prompt",
      listPromptKey: "step.plan.listPrompt",
      listButtonKey: "step.plan.listButton",
      noneKey: "step.plan.none",
      parser: "plan",
      source: "plans",
      stores: ["plan_id", "plan_name", "premium", "currency", "validity_days"],
      next: "review",
      // Skipped automatically when exactly one plan can be priced.
      autoSkipWhenSingle: true,
    },

    review: {
      key: "review",
      type: "quote_review",
      promptKey: "quote.question",
      options: [
        { id: "quote:confirm", labelKey: "quote.confirm" },
        { id: "quote:edit", labelKey: "review.edit" },
        { id: "quote:cancel", labelKey: "quote.cancel" },
      ],
      parser: "reviewChoice",
      next: "done",
    },

    review_edit: {
      key: "review_edit",
      type: "list",
      promptKey: "review.editPrompt",
      listButtonKey: "review.editButton",
      parser: "editChoice",
      next: "review",
    },

    // ---- payment (Milestone 3) ---------------------------------------------
    // Reached from `review` only when payment is switched on AND at least one
    // provider is configured for the customer's country. Otherwise `review`
    // still goes straight to `done` and an adviser calls, exactly as before —
    // so an unconfigured platform behaves the way it did in Milestone 2.

    payment_provider: {
      key: "payment_provider",
      type: "dynamic_list",
      source: "providers",
      promptKey: "payment.choose",
      listButtonKey: "payment.chooseButton",
      parser: "paymentProvider",
      stores: ["payment_provider"],
      next: "payment_phone",
    },

    payment_phone: {
      key: "payment_phone",
      type: "text",
      promptKey: "payment.askPhone",
      parser: "paymentPhone",
      stores: ["payment_msisdn"],
      next: "payment_wait",
    },

    // Where the conversation parks. Nothing the customer sends advances it —
    // only the provider's callback, or the sweeper giving up, does. A message
    // arriving here is answered with "still waiting" rather than treated as an
    // answer to a question we did not ask.
    payment_wait: {
      key: "payment_wait",
      type: "payment_wait",
      promptKey: "payment.waiting",
    },

    // Offered after a failure, so a customer can retry or switch operator
    // without re-entering a single field.
    payment_retry: {
      key: "payment_retry",
      type: "buttons",
      promptKey: "payment.retryPrompt",
      options: [
        { id: "pay:retry", labelKey: "payment.retry" },
        { id: "pay:switch", labelKey: "payment.switchProvider" },
        { id: "pay:cancel", labelKey: "payment.cancel" },
      ],
      parser: "paymentRetryChoice",
      next: "payment_wait",
    },

    done: {
      key: "done",
      type: "terminal",
      promptKey: "quote.confirmed",
    },
  },
};

/** Steps offered on the review screen's "change a detail" list, in flow order. */
export const EDITABLE_STEPS = [
  "identity_last_name",
  "identity_first_name",
  "identity_dob",
  "gender",
  "nationality",
  "residence",
  "passport",
  "destination_dates",
  "travel_dates",
  "email",
  "phone",
];

export function getStep(flow, key) {
  return flow?.steps?.[key] || null;
}

/** Resolve a step's `next`, which may be a function of the collected data. */
export function resolveNext(step, collectedData) {
  if (!step) return null;
  if (typeof step.next === "function") return step.next(collectedData || {});
  return step.next || null;
}

/**
 * Merge a stored flow definition over the built-in one.
 *
 * A row in `whatsapp_flows` may override prompts and step order, but it cannot
 * invent a parser — the engine only knows the parsers it ships with, so an
 * unknown parser name falls back to the built-in step rather than breaking the
 * conversation for every customer.
 */
export function mergeFlowDefinition(stored) {
  if (!stored || typeof stored !== "object" || !stored.steps) return FLOW;
  const merged = { ...FLOW, ...stored, steps: { ...FLOW.steps } };
  for (const [key, override] of Object.entries(stored.steps)) {
    const base = FLOW.steps[key];
    if (!base) continue; // ignore unknown steps
    const safe = { ...override };
    if (safe.parser && safe.parser !== base.parser) delete safe.parser;
    merged.steps[key] = { ...base, ...safe };
  }
  return merged;
}
