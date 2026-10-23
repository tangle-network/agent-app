/** Best-effort propagation runs only after the owning membership mutation commits. */
export function fireMemberSync(op: () => Promise<void> | void): void {
  try {
    Promise.resolve(op()).catch(() => {})
  } catch {
    // A synchronous downstream refusal cannot undo committed membership.
  }
}
