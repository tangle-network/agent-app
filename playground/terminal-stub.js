// Dev-only stub for `@tangle-network/sandbox-ui/terminal`. web-react's barrel
// statically pulls workspace-terminal-panel, which lazy-imports the sandbox-ui
// terminal (and its @xterm deps). The playground never renders the terminal, so
// alias it here to keep Vite's optimizer from resolving @xterm.
export const TerminalView = () => null
export default {}
