/** A correctable bad-input error a tool handler throws; the HTTP layer maps it
 *  to a 4xx with the code, the runtime layer to a failed tool_result. So the
 *  agent learns the call failed and can correct, instead of a silent success. */
export class ToolInputError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message)
    this.name = 'ToolInputError'
  }
}
