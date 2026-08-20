/**
 * Live Orchestration Graph — the "wow" view (Phase 3 delight). A fixed radial
 * layout: the orchestrator pinned dead-center, workers on a stable ring, and
 * tasks flowing along fixed edges through a verify gate that turns green only
 * after the tests pass. Driven by the same live event stream as the rest of the
 * dashboard. Never force-directed; nodes never reshuffle. (Placeholder for now —
 * the graph lands in the following commits.)
 */
export function OrchestrationScreen() {
  return (
    <div className="grid place-items-center min-h-[60vh] text-fg-muted">
      <div className="text-center">
        <div className="text-[13px] mono">orchestration graph</div>
        <div className="text-[11px] text-fg-faint mt-1">coming next</div>
      </div>
    </div>
  )
}
