/** A correctable bad-input error a tool handler throws; the HTTP layer maps it
 *  to a 4xx with the code, the runtime layer to a failed tool_result. So the
 *  agent learns the call failed and can correct, instead of a silent success. */
export declare class ToolInputError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status?: number);
}
