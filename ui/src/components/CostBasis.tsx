/**
 * CostBasis — the one line that says what a dollar figure on this dashboard
 * actually is.
 *
 * Every hero cost in the product is computed from captured tokens at the
 * model maker's API list prices — Anthropic's for Claude, OpenAI's for GPT,
 * and so on; never "Anthropic" alone, since Codex and Gemini turns sit in the
 * same totals. For most users that is *not* a bill: on Pro or Max the money
 * already left as a flat fee, and this figure is what the same work would have
 * cost through the API. Shown to five readers, "$586" with no qualifier was
 * read as an amount owed by three of them — the number is large, it has a
 * dollar sign, and nothing on the tile says otherwise.
 *
 * The wording has to follow the plan, which is why this is a component rather
 * than a copied string:
 *  - flat plan → an equivalent, explicitly not money out of pocket;
 *  - metered (API key, Bedrock, Vertex) → it IS approximately the bill, and
 *    calling it an equivalent would be the same lie in the other direction;
 *  - plan unstated → say the basis without claiming which case applies, and
 *    ask under the hero figures (components/PlanAsk: four chips, a hint when
 *    Claude Code reports plan windows, "Not now" kept per browser).
 *
 * The hero label follows the same split: "Work at API prices" on a flat plan,
 * with "Covered by your <plan> plan." under it instead of the basis line, and
 * "Cost" otherwise — metered users are billed per token, and an unstated plan
 * is asked rather than assumed either way.
 *
 * It lives next to the number instead of in a corner footnote because that is
 * where the misreading happens. "API-equivalent" as a bare subtitle does not
 * work either: it is our jargon, and it explains nothing to someone meeting
 * the number for the first time.
 */
import type { Settings } from '@/lib/api'

/**
 * What to call the hero figure, which is not "cost" for everyone.
 *
 * On a flat plan the number is what this work would have cost through the API
 * — it is emphatically not what anyone was charged. Labelled "Cost", the
 * largest figure on the screen names itself as money spent and then denies it
 * in grey underneath, and a subscriber reads the whole screen as an accusation
 * of waste (FB-026: "all about if you were a fool and paid for tokens instead
 * of a subscription"). "Worth at API list" (until 2026-11-22) said value, not
 * work; "Work at API prices" says what was done and how it is priced.
 * Metered users *are* billed per token, so for them the word is right and
 * stays.
 */
export function costLabel(plan?: Settings): string {
  return plan?.plan_kind === 'flat' ? 'Work at API prices' : 'Cost'
}

/** The subtitle for a hero cost figure, in plain words. */
export function costBasis(plan?: Settings): string {
  if (plan?.plan_kind === 'metered') return 'at API list price · ≈ your bill'
  if (plan?.plan_kind === 'flat') return 'at API list price · not a bill'
  return 'at API list price'
}

/** The longer form, for a panel header or a tooltip. */
export function costBasisLong(plan?: Settings): string {
  if (plan?.plan_kind === 'metered') {
    return 'Roughly your real bill — you pay per token. At API list prices.'
  }
  if (plan?.plan_kind === 'flat') {
    return `At API list prices — what this work would cost through the API. You pay ${plan.plan_label || 'a flat plan'}, so it is not money out of pocket.`
  }
  return 'At API list prices. Set your plan in the header to see how it compares to your bill.'
}
