/**
 * The per-directory breakdown as a TREE, built from the flat list the daemon
 * sends.
 *
 * WHAT WAS WRONG. `/v1/stats/summary` returns one row per touched directory,
 * ranked by cost, each written as a full path from the repository root. On the
 * owner's `caprock` that is 43 rows at depths 0 to 4 — `/ui/src/components`,
 * `/ui/src/screens`, `/ui/src/lib`, `/ui/src`, `/internal/store`, `/internal/api`,
 * `/.ai`, `/` — with nothing on screen saying that the first three live inside
 * `/ui`. The list is sorted, so it answers "what is most expensive"; it cannot
 * answer "what does /ui cost", which is the question a monorepo asks, and at 43
 * rows the eye cannot find anything either way.
 *
 * WHY THIS IS CLIENT-SIDE AND NOT IN THE DAEMON. The flat list already carries
 * every figure the tree needs — cost, tokens and turns per path — so the tree is
 * pure arithmetic over a payload that is already on the wire. Three reasons that
 * settles it:
 *
 *   - The DEPTH CAP IS A DISPLAY CHOICE. Three levels is what fits a panel that
 *     shares a screen with the live feed; it is not a fact about the user's
 *     repository. Encoding it in the API would make every future consumer — a
 *     wider screen, an export, the Cost screen — inherit one panel's layout
 *     budget, and changing it would be a contract change (rule 8) for a
 *     stylesheet-sized decision.
 *   - The CONTRACT STAYS UNCHANGED. No DDL, no migration, no `03-contracts.md`
 *     edit for the payload shape — rule 8 is satisfied by not triggering it.
 *   - The FLAT LIST IS STILL THE TRUTH. Building the tree from it, rather than
 *     receiving a second pre-rolled shape, means the two can never disagree: the
 *     invariant `sum(tree) === sum(flat)` is checkable in a unit test rather
 *     than being a property of two independent aggregations.
 *
 * The cost is one O(n log n) pass over at most a few dozen rows per repository,
 * on data the panel already has in memory.
 */
import type { PathShare } from './api'

/**
 * How many levels of directory the panel will ever show.
 *
 * The owner's rule, in his words: show one level on expand; if there is more
 * inside, let him expand again; stop at three. `/ui/src/screens` is the deepest
 * thing reachable, and `/ui/src/screens/orchestration` — a real row on his data
 * — is not a row of its own.
 *
 * Three is not arbitrary. Level 1 is the top-level split every repository has
 * (`/ui`, `/internal`, `/.ai`); level 2 is where a monorepo's real units live
 * (`/ui/src`, `/services/api`); level 3 is the last depth at which a name still
 * describes a component rather than a file's neighbourhood. Below that the
 * directory is an implementation detail of the level above it, and a budget
 * question is never asked at that grain.
 */
export const MAX_DEPTH = 3

/**
 * One node of the tree.
 *
 * The two figures a node carries are DIFFERENT QUESTIONS and both are needed:
 *
 *   - `tokens` / `cost` / `turns` are the SUBTREE roll-up — everything at or
 *     below this path. This is what the row states, because "what does /ui
 *     cost" means the whole of /ui.
 *   - `ownTokens` / `ownCost` / `ownTurns` is the spend charged to THIS
 *     directory itself — work that touched a file directly in `/ui`, not in
 *     `/ui/src`. Without it a reader cannot tell "this directory cost X" from
 *     "this subtree cost X", which are the same number only for a leaf.
 *
 * `rolledUp` is the part of the subtree that came from paths DEEPER than the cap
 * and has nowhere of its own to be shown. It is not lost and it is not silent:
 * the row states that it contains deeper directories, because a number that
 * quietly absorbs its children is exactly the kind of unexplained figure rule 6
 * exists to prevent.
 */
export interface PathNode {
  /** Full path from the repository root, as the daemon writes it: `/ui/src`. */
  path: string
  /** The last segment, which is what the row shows once indented: `src`. */
  name: string
  /** Depth below the root: `/ui` is 1, `/ui/src` is 2. The root `/` is 0. */
  depth: number
  /** Subtree totals — this node and everything beneath it. */
  tokens: number
  cost: number
  turns: number
  /**
   * The subtree's share of the REPOSITORY total, summed from the shares the
   * daemon sent per flat path rather than recomputed from the tokens above.
   *
   * The two would usually agree, and where they do not the SERVER is right: it
   * divides by the repository total including the rows that are not
   * directories, which is a denominator the panel does not have — the flat rows
   * it was handed may not be all of them. Recomputing here would silently
   * substitute a different base and put a percentage on screen that the
   * contract does not describe (rule 6). Summing is exact for the same reason
   * the tokens are: every flat row lands in exactly one chain of ancestors.
   */
  tokensPct: number
  costPct: number
  /** Charged to this directory itself, excluding every child. */
  ownTokens: number
  ownCost: number
  ownTurns: number
  /** This directory's own share, on the same basis as `tokensPct`. */
  ownTokensPct: number
  ownCostPct: number
  /** Directories one level down, ranked by cost. Empty at the cap or at a leaf. */
  children: PathNode[]
  /**
   * How many descendant directories below the cap were folded into this node's
   * totals because they are deeper than the panel will show. Zero for every node
   * that is not at the cap.
   */
  rolledUp: number
  /** The row is a bucket, not a directory — `outside`/`unattributed`. */
  bucket?: PathShare
}

/**
 * The breakdown, ready to render: the directory tree plus the rows that are not
 * directories.
 *
 * THE REPOSITORY ROOT IS NOT A ROW OF THE TREE. Every path in a repository is
 * under `/`, so a tree with `/` as its single root would put one row between the
 * reader and everything they came for — a click whose only outcome is another
 * click, on every repository, forever. The repository row ABOVE the breakdown
 * already states the root's subtree total; `/` as a node would restate it.
 *
 * So `roots` is what sits DIRECTLY under the repository root — `/ui`,
 * `/internal`, `/.ai` — and the root's OWN spend (turns that touched a file
 * directly in the checkout root: `README.md`, `Makefile`, `go.mod`) becomes a
 * leaf row of its own, still written `/`. It is a sibling of `/ui` rather than
 * its parent, which is what it actually is: another directory whose files were
 * touched, one that happens to be the root. The row is present only when that
 * spend exists.
 *
 * The buckets are kept OUT of the tree rather than parented to the root. They
 * are not paths — their `path` is a sentinel — so giving them a place in a path
 * hierarchy would be a lie about where the work happened, and nesting them under
 * `/` would charge the repository root with a quarter of the bill it never saw.
 */
export interface PathTree {
  roots: PathNode[]
  buckets: PathShare[]
}

/** Split a repository-relative path into its segments. `/` is the empty list. */
function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/**
 * Build the tree from the daemon's flat list.
 *
 * THE INVARIANT THIS EXISTS TO KEEP. Every input row's tokens, cost and turns
 * land in exactly one node's `own*` figures and in the subtree totals of that
 * node's ancestors — so `sum(roots.tokens) + sum(buckets.tokens)` equals the
 * flat list's total exactly, at any depth cap, for any input. The repository row
 * above the breakdown states that same total, and the panel must never show two
 * different totals for one repository (rule 6).
 *
 * WHAT HAPPENS TO SPEND DEEPER THAN THE CAP. It is charged to the deepest
 * VISIBLE ancestor's `own*` figures. It cannot be dropped — the parts would stop
 * summing to the whole — and it cannot be given a row, because that is what the
 * cap forbids. Rolling it into the ancestor is the only remaining option that
 * preserves the total, and it is defensible on its own terms: `/ui/src/screens`
 * is a truthful home for `/ui/src/screens/orchestration`, in a way that `/ui`
 * would not be. What makes it honest rather than a silent absorption is that the
 * node counts how many directories it swallowed (`rolledUp`) and the row says
 * so.
 *
 * A path with no matching intermediate row still gets its ancestors: a
 * repository whose only rows are `/a/b/c` and `/a/x` still shows `/a` with both
 * beneath it, with `/a`'s own spend at zero. Those synthesised nodes are real
 * directories with a real subtree total and no spend of their own, which is
 * exactly what the two figures are for.
 */
export function buildPathTree(paths: PathShare[], maxDepth = MAX_DEPTH): PathTree {
  const buckets: PathShare[] = []
  const byPath = new Map<string, PathNode>()
  const roots: PathNode[] = []

  const node = (path: string, depth: number): PathNode => {
    const found = byPath.get(path)
    if (found) return found
    const segs = segments(path)
    const made: PathNode = {
      path,
      name: segs.length === 0 ? '/' : (segs[segs.length - 1] as string),
      depth,
      tokens: 0,
      cost: 0,
      turns: 0,
      tokensPct: 0,
      costPct: 0,
      ownTokens: 0,
      ownCost: 0,
      ownTurns: 0,
      ownTokensPct: 0,
      ownCostPct: 0,
      children: [],
      rolledUp: 0,
    }
    byPath.set(path, made)
    if (depth === 0) {
      roots.push(made)
    } else {
      // The parent of `/ui/src` is `/ui`; the parent of `/ui` is the root `/`.
      const parentPath = depth === 1 ? '/' : '/' + segs.slice(0, depth - 1).join('/')
      node(parentPath, depth - 1).children.push(made)
    }
    return made
  }

  for (const p of paths) {
    // The two rows that are not directories never enter the hierarchy — see
    // PathTree. They keep their own figures and their own place in the panel.
    if (p.unattributed || p.outside) {
      buckets.push(p)
      continue
    }
    const segs = segments(p.path)
    // The row's own depth, and the depth it is actually shown at. A path deeper
    // than the cap is charged to its deepest visible ancestor.
    const ownDepth = segs.length
    const shownDepth = Math.min(ownDepth, maxDepth)
    const shownPath = shownDepth === 0 ? '/' : '/' + segs.slice(0, shownDepth).join('/')
    const target = node(shownPath, shownDepth)
    target.ownTokens += p.tokens
    target.ownCost += p.cost_usd
    target.ownTurns += p.turns
    target.ownTokensPct += p.tokens_pct
    target.ownCostPct += p.cost_pct
    if (ownDepth > shownDepth) target.rolledUp++
    // Every ancestor's subtree total, including the node itself. This is the
    // single place the invariant is maintained: one input row contributes to
    // exactly one chain of nodes, from the root down to where it is shown.
    for (let d = 0; d <= shownDepth; d++) {
      const ancestorPath = d === 0 ? '/' : '/' + segs.slice(0, d).join('/')
      const a = node(ancestorPath, d)
      a.tokens += p.tokens
      a.cost += p.cost_usd
      a.tokensPct += p.tokens_pct
      a.costPct += p.cost_pct
      a.turns += p.turns
    }
  }

  // Lift the repository root: its children become the first level, and its own
  // spend becomes a leaf beside them. See PathTree for why `/` must not be a row
  // that everything else hides behind.
  const root = roots[0]
  let top: PathNode[] = roots
  if (root && root.path === '/') {
    top = [...root.children]
    if (root.ownTokens > 0 || root.ownCost > 0 || root.ownTurns > 0 || root.rolledUp > 0) {
      top.push({
        ...root,
        // It sits BESIDE `/ui`, so it is drawn at that level: the root's own
        // files are one of the repository's directories, not a tier above them.
        depth: 1,
        // The row states only what was charged to the root ITSELF; its subtree
        // is the sibling rows next to it, and counting them here too would show
        // the repository's whole total inside its own breakdown.
        tokens: root.ownTokens,
        cost: root.ownCost,
        turns: root.ownTurns,
        tokensPct: root.ownTokensPct,
        costPct: root.ownCostPct,
        // The root's own spend is a leaf: its subdirectories are its siblings
        // here, so keeping them as children would list each of them twice.
        children: [],
        ownTokens: root.ownTokens,
        ownCost: root.ownCost,
        ownTurns: root.ownTurns,
      })
    }
  }

  // Ranked by cost at every level, matching the order the daemon sends the flat
  // list in — the panel's existing answer to "which of these is expensive".
  const sortDeep = (ns: PathNode[]) => {
    ns.sort((a, b) => b.cost - a.cost)
    for (const n of ns) sortDeep(n.children)
  }
  sortDeep(top)
  return { roots: top, buckets }
}

/**
 * Collapse a chain of single-child directories into one row.
 *
 * `/ui` on the owner's data holds nothing but `/ui/src`, and `/ui/src` in turn
 * holds `/ui/src/components`, `/ui/src/screens` and `/ui/src/lib`. Without this,
 * reaching the three interesting rows costs two clicks, the first of which
 * reveals exactly one row restating the total just clicked — a click whose only
 * outcome is another click.
 *
 * WHY THIS IS SAFE HERE AND NOT ALWAYS. A breadcrumb collapses because the
 * intermediate name carries no information; the risk is that it hides a
 * DIFFERENCE. Here there is a concrete difference to check: if `/ui` has spend
 * of its OWN (a turn that touched a file directly in `/ui`), collapsing it into
 * `/ui/src` would move that money into a directory it did not happen in. So the
 * collapse is conditional — a node merges into its only child only when it has
 * no own spend to lose. That is the case for `/ui` on the owner's data (its
 * single row's spend belongs to `/ui` itself, so it does NOT collapse) and for
 * the synthesised ancestors this module creates, which by construction have
 * none.
 *
 * The collapsed row keeps the FULL path as its name (`/ui/src`), because the
 * information the intermediate node carried is the path itself, and a row
 * reading `src` under a repository called `caprock` would have thrown it away.
 *
 * IT DOES NOT CONSUME DEPTH. The merged node keeps the CHILD's depth, so the cap
 * still counts real directory levels: collapsing `/a` into `/a/b` must not cost
 * `/a/b` its own expansion. The totals are untouched by construction — a node
 * with no own spend has exactly its only child's subtree totals.
 */
export function collapseChains(nodes: PathNode[]): PathNode[] {
  return nodes.map((n) => {
    let cur = n
    // Merge only while the node is a pure pass-through: one child, nothing
    // charged to itself, and nothing rolled up into it.
    while (
      cur.children.length === 1 &&
      cur.ownTokens === 0 &&
      cur.ownCost === 0 &&
      cur.ownTurns === 0 &&
      cur.rolledUp === 0
    ) {
      cur = cur.children[0] as PathNode
    }
    return { ...cur, children: collapseChains(cur.children) }
  })
}
