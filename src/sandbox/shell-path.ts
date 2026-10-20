

// Single-quote a string for safe interpolation into a shell command.
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Build a shell-safe path token that preserves tilde-home semantics. A path
// beginning `~/` (or a bare `~`) must resolve to the box user's real `$HOME`,
// but single-quoting the whole path suppresses shell `~` expansion and lands
// the file in a literal directory named `~`. Expand the leading `~` to an
// UNQUOTED `"$HOME"` (so the shell expands it) and single-quote only the
// remainder. Absolute and relative paths are single-quoted unchanged.
export function shellPath(path: string): string {
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) {
    const rest = path.slice(2)
    return rest ? `"$HOME"/${shellSingleQuote(rest)}` : '"$HOME"'
  }
  return shellSingleQuote(path)
}
