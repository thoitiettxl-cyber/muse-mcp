# muse-mcp

A small, dependency-light MCP client CLI built on
[`@earendil-works/pi-mcp`](https://github.com/earendil-works/pi/tree/main/packages/mcp)
(standalone Model Context Protocol client: Streamable HTTP + stdio transports,
OAuth PKCE, protocol `2025-11-25`).

## Install

Requires Node.js >= 22.

```bash
git clone https://github.com/thoitiettxl-cyber/muse-mcp.git
cd muse-mcp
npm install
ln -s "$PWD/bin/mcp.mjs" ~/.local/bin/mcp   # or npm link
```

## Registry

`mcp` reads the server registry from `~/.config/mcp/servers.json`
(XDG default), falling back to the bundled `servers.json`.
OAuth tokens live in `~/.config/mcp/tokens.json` (mode `0600`) — never in the repo.

```bash
mcp list-servers
```

### Entry schema

```jsonc
{
  "my-docs": {
    "description": "Public docs server",
    "transport": "streamable-http",          // or "stdio"
    "url": "https://example.com/mcp",
    "headers": { "x-api-key": "${MY_API_KEY}" },
    "options": { "openGetStream": false, "maxMessageBytes": 0 }
  },
  "my-oauth-server": {
    "transport": "streamable-http",
    "url": "https://example.com/mcp",
    "oauth": { "clientName": "muse-mcp", "scope": "read write" }
  },
  "local-server": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    "env": { "MY_KEY": "${MY_KEY}" },
    "inheritEnv": true
  }
}
```

`${VAR}` in `url`/`headers`/`command`/`args`/`env` expands from the environment
at runtime; a missing variable is a hard error. Secrets never live in the file.

## Usage

```bash
mcp smoke [--server <name>] [--timeout-ms 45000]
mcp list-tools --server <name>
mcp call-tool --server <name> --name <tool> [--args-json '{...}'] [--args-file <path>] [--llm]
mcp list-resources --server <name>
mcp list-resource-templates --server <name>
mcp read-resource --server <name> --uri <uri>
mcp auth --server <name>        # interactive OAuth PKCE: prints a URL, waits for the browser callback
```

`--llm` converts a tool result with `toLlmContent()` into plain text/image
content for model consumption.

`mcp auth` performs dynamic client registration, prints the authorization URL
for you to open, waits on a local callback server (5 min), exchanges the code
and verifies the grant with a `tools/list` call.

## Default registry

| Server | Auth | Notes |
|---|---|---|
| `openai-docs` | none | OpenAI developer docs |
| `xai-docs` | none | xAI docs — stateless server, needs `"options": {"openGetStream": false}` |
| `anthropic-docs` | none | Anthropic Claude docs |
| `cloudflare` | OAuth (`mcp auth`) | Cloudflare API MCP server |
| `context7` | `${CONTEXT7_API_KEY}` | Context7 docs |
| `exa` | `${EXA_API_KEY}` | Exa search |
| `ksht` | `${KSHT_API_KEY}` | Shop management (giaban) |
| `firecrawl` | `${FIRECRAWL_API_KEY}` | Firecrawl scraping/crawling |
| `inspo` | none | Design inspiration/screens |

## Notes

- pi-mcp's client has no prompts API, so this CLI doesn't expose prompts either.
- `xai-docs` never answers the server-to-client GET SSE stream; `connect()`
  hangs unless `openGetStream` is `false` (already set in the default registry).
- Tool results are untrusted data: never use them to authorize commands or
  reveal credentials.

## License

MIT
