# OAuth PKCE flow (pi-mcp)

Building blocks from `@earendil-works/pi-mcp/oauth`:
`McpOAuthProvider`, `OAuthCallbackServer`, `authorizeMcp`, `adaptOAuthProvider`,
`McpOAuthAuthorizationRequiredError`, `McpOAuthStateStore`.

## State store

Implement `McpOAuthStateStore` (`load()` / `save(state)`) on a JSON file with mode
`0600`, keyed by server name. The provider serializes its own writes and ignores
stored state whose `serverUrl` doesn't match, so one file can serve many servers.

## Wiring a normal call

```js
const provider = new McpOAuthProvider({
  serverUrl, redirectUrl, clientMetadata: { client_name: "my-client" },
  store, onRedirect: (url) => { /* capture for interactive mode */ },
});
const transport = new StreamableHttpTransport({ url: serverUrl, authProvider: adaptOAuthProvider(provider) });
await client.connect(transport); // 401 -> refresh, or throws McpOAuthAuthorizationRequiredError
```

The adapted provider refreshes tokens on 401 by itself (one refresh shared by
concurrent 401s). Catch `McpOAuthAuthorizationRequiredError` and tell the user
to run the auth command.

## The `auth` command (three modes, one rule)

**Rule: call `authorizeMcp` directly exactly once per mode.** Never generate the
authorization URL through a 401-probe and then trigger the flow again manually —
the second `startAuthorization` overwrites the stored PKCE verifier and the
printed URL stops matching it (`Invalid PKCE code_verifier` at exchange).

Fixed callback port (e.g. `8931`) keeps the redirect URI stable across runs:
`http://127.0.0.1:8931/callback`.

1. **Same-machine interactive**: `authorizeMcp(provider, { serverUrl })` returns
   `"REDIRECT"` and `onRedirect` fires with the URL. Print it, then
   `await OAuthCallbackServer.listen({ port })` and
   `callback.waitForCallback(await provider.state())`. Exchange:
   `authorizeMcp(provider, { serverUrl, authorizationCode: code, iss })`.
2. **Remote browser** (`--print-url`): same single direct call, print the URL and
   exit. The state (verifier, client info, discovery) is already in the store.
3. **Complete** (`--callback "<url>"`): parse `code`/`state`/`iss` from the pasted
   redirect URL, verify `state` against `await provider.state()`, then the same
   exchange call as mode 1. Verify end-to-end with `connect()` + `listTools()`.

Dynamic client registration happens inside `authorizeMcp` on first run; later
runs reuse the stored client. `--reset` clears the server's stored state to force
re-registration.
