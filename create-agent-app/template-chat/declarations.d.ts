/**
 * Text-module declarations. `prompts/system.md` is imported as a plain string
 * by `agent.config.ts`; wrangler loads it via the `[[rules]]` Text rule in
 * wrangler.toml and vitest via the inline plugin in vitest.config.ts.
 */
declare module '*.md' {
  const text: string
  export default text
}
