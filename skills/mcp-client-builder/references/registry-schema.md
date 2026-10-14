# Registry schema

`servers.json` maps a server name to one entry. `${VAR}` in `url`, `headers`,
`command`, `args` and `env` values expands from the environment at runtime;
a missing variable is a hard error (a call never goes out half-substituted).

## Streamable HTTP (public)

```json
{
  "openai-docs": {
    "description": "OpenAI developer documentation MCP server",
    "transport": "streamable-http",
    "url": "https://developers.openai.com/mcp"
  }
}
```

With a static secret (never commit the value):

```json
{
  "exa": {
    "transport": "streamable-http",
    "url": "https://mcp.exa.ai/mcp",
    "headers": { "x-api-key": "${EXA_API_KEY}" }
  }
}
```

`options` passes a subset of `StreamableHttpTransportOptions` through — the
reference CLI forwards `openGetStream` and `maxMessageBytes` (e.g. set
`openGetStream: false` for stateless servers, see quirks below):

```json
{
  "xai-docs": {
    "transport": "streamable-http",
    "url": "https://docs.x.ai/api/mcp",
    "options": { "openGetStream": false }
  }
}
```

## Streamable HTTP (OAuth)

```json
{
  "cloudflare": {
    "transport": "streamable-http",
    "url": "https://mcp.cloudflare.com/mcp",
    "oauth": { "clientName": "muse-mcp", "scope": "read write", "callbackPort": 8931 }
  }
}
```

`scope` and `callbackPort` are optional (defaults: server-advertised scope, `8931`).
See [oauth-flow.md](oauth-flow.md) for the `mcp auth` sequence.

## Stdio (local server)

```json
{
  "local-docs": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    "env": { "MY_KEY": "${MY_KEY}" },
    "inheritEnv": true,
    "cwd": "/tmp"
  }
}
```

`command` is required; `args`/`env`/`cwd` are optional. `inheritEnv` defaults to `true`.
pi-mcp shuts the child down per spec (close stdin, then SIGTERM, then SIGKILL
on the whole process group).

## Known quirks

- **xai-docs** (`https://docs.x.ai/api/mcp`) is stateless and never answers the
  server-to-client GET SSE stream. With pi-mcp's default `openGetStream: true`,
  `connect()` hangs until timeout. Always set `"options": {"openGetStream": false}`.
- A bare `curl` POST that returns `200` slowly (10s+) while `initialize` via the
  client times out is the same symptom: the GET stream, not the endpoint, is stuck.
