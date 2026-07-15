// References --nonexistent-token via a literal var(), which the fixture
// tokens.css never defines → the var(--…) check must flag it, attributing the
// miss to this file.
export function BadVarComponent() {
  return <span style={{ color: 'var(--nonexistent-token)' }}>invisible text</span>
}
