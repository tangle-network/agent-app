// src/tangle/index.ts
function buildConsentUrl(input) {
  const base = input.endpoint.replace(/\/+$/, "");
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(" "),
    state: input.state,
    response_type: "code"
  });
  if (input.connectionId) params.set("connection_id", input.connectionId);
  return `${base}/cross-site/app-consent?${params.toString()}`;
}
function createBrokerTokenProvider(opts) {
  return {
    async getToken() {
      const token = await opts.client.mintBrokerToken({
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        grantId: opts.grantId,
        ttlSeconds: opts.ttlSeconds
      });
      return token.accessToken;
    },
    invalidate() {
    }
  };
}
export {
  buildConsentUrl,
  createBrokerTokenProvider
};
//# sourceMappingURL=index.js.map