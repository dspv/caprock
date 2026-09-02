/**
 * CostBasis — the one line that says what a dollar figure on this dashboard
 * actually is.
 *
 * Every hero cost in the product is computed from captured tokens at Anthropic
 * list prices. For most users that is *not* a bill: on Pro or Max the money
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
 *  - plan unstated → say the basis without claiming which case applies.
 *
 * It lives next to the number instead of in a corner footnote because that is
 * where the misreading happens. "API-equivalent" as a bare subtitle does not
 * work either: it is our jargon, and it explains nothing to someone meeting
 * the number for the first time.
 */
import type { Settings } from '@/lib/api'

/** The subtitle for a hero cost figure, in plain words. */
export function costBasis(plan?: Settings): string {
  if (plan?.plan_kind === 'metered') return 'at API list price · ≈ your bill'
  if (plan?.plan_kind === 'flat') return 'at API list price · not a bill'
  return 'at API list price'
}

/** The longer form, for a panel header or a tooltip. */
export function costBasisLong(plan?: Settings): string {
  if (plan?.plan_kind === 'metered') {
    return 'Roughly your real bill — you pay per token. At Anthropic list prices.'
  }
  if (plan?.plan_kind === 'flat') {
    return `At Anthropic list prices — what this work would cost through the API. You pay ${plan.plan_label || 'a flat plan'}, so it is not money out of pocket.`
  }
  return 'At Anthropic list prices. Set your plan in the header to see how it compares to your bill.'
}
