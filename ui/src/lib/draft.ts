// Text another screen left for a session's terminal field: the Changes tab's
// "Ask the agent" writes it, the keys bar takes it once when it mounts.
const drafts = new Map<string, string>()

export function setDraft(sessionId: string, text: string): void {
  drafts.set(sessionId, text)
}

/** The draft left for this session, removed so it is used once. */
export function takeDraft(sessionId: string): string {
  const text = drafts.get(sessionId) ?? ''
  drafts.delete(sessionId)
  return text
}
