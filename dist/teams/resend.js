import {
  renderInvitationEmail
} from "../chunk-2DRYTJHI.js";

// src/teams/resend.ts
import { Resend } from "resend";
function createResendInvitationSender(opts) {
  let client = null;
  function getClient() {
    if (client) return client;
    const key = opts.apiKey ?? (typeof process !== "undefined" ? process.env.RESEND_API_KEY : void 0);
    if (!key) return null;
    client = new Resend(key);
    return client;
  }
  return async (input) => {
    const resend = getClient();
    if (!resend) return { succeeded: false, error: "RESEND_API_KEY is not configured" };
    const msg = renderInvitationEmail(input, { fromAddress: opts.from });
    try {
      const result = await resend.emails.send({
        from: msg.from,
        to: input.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text
      });
      if (result.error) return { succeeded: false, error: result.error.message };
      return { succeeded: true };
    } catch (err) {
      return { succeeded: false, error: err instanceof Error ? err.message : "Invitation email failed to send" };
    }
  };
}
export {
  createResendInvitationSender
};
//# sourceMappingURL=resend.js.map