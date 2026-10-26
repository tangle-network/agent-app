/** The consumer's installed, published agent-app turn-stream, aliased into the durable-stop workerd bundle as an older receiver. */
declare module 'agent-app-published-turn-stream' {
  export const TURN_STREAM_PATHS: Record<string, string>
  export class TurnStreamDO { constructor(state: unknown, env: unknown, options?: unknown); fetch(request: Request): Promise<Response> }
}
