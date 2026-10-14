#!/usr/bin/env node
/**
 * mcp — MCP client CLI built on @earendil-works/pi-mcp
 * (template: https://github.com/earendil-works/pi/tree/main/packages/mcp)
 *
 * Default registry: ~/.config/mcp/servers.json (symlink -> ~/workspace/mcp/servers.json)
 * OAuth tokens (never in git): ~/.config/mcp/tokens.json (0600)
 *
 * Commands:
 *   mcp list-servers
 *   mcp smoke [--server <name>] [--timeout-ms <n>]
 *   mcp list-tools --server <name>
 *   mcp call-tool --server <name> --name <tool> [--args-json '{...}'] [--args-file <path>] [--llm]
 *   mcp list-resources --server <name>
 *   mcp list-resource-templates --server <name>
 *   mcp read-resource --server <name> --uri <uri>
 *   mcp auth --server <name>            # interactive OAuth PKCE flow (opens URL for the user)
 *
 * Registry entry:
 *   { "description", "transport": "streamable-http", "url", "headers"?: {...},
 *     "options"?: { "openGetStream", "maxMessageBytes" },
 *     "oauth"?: { "clientName"?: string },                       # streamable-http + OAuth
 *     "transport": "stdio", "command", "args"?: [], "env"?: {...}, # stdio server
 *     "cwd"?: string, "inheritEnv"?: bool }
 * `${VAR}` in url/headers/command/args/env values expands from the environment.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const HOME = process.env.HOME || process.env.USERPROFILE || ".";
const CONFIG_DIR = resolve(HOME, ".config/mcp");
const TOKENS_PATH = resolve(CONFIG_DIR, "tokens.json");

const { McpClient, StreamableHttpTransport, StdioTransport, toLlmContent } = await import(
  "@earendil-works/pi-mcp"
);

const DEFAULT_TIMEOUT_MS = 45000;

function registryPaths() {
  return [
    resolve(CONFIG_DIR, "servers.json"), // system default
    resolve(PROJECT_ROOT, "servers.json"), // bundled fallback
  ];
}

function loadRegistry() {
  for (const p of registryPaths()) {
    if (existsSync(p)) {
      return { servers: JSON.parse(readFileSync(p, "utf8")), path: p };
    }
  }
  throw new Error(`no registry found (tried: ${registryPaths().join(", ")})`);
}

function getArg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

/**
 * Expand ${VAR} placeholders from the environment.
 * Throws if a referenced variable is missing or empty, so a call never
 * goes out with a half-substituted secret.
 */
function expandEnv(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined || v === "") {
      throw new Error(`missing required env var "${name}" (referenced as \${${name}})`);
    }
    return v;
  });
}

function expandMap(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, expandEnv(v)]));
}

/** File-backed OAuth state store: ~/.config/mcp/tokens.json (0600), keyed by server name. */
class FileOAuthStateStore {
  constructor(serverName) {
    this.serverName = serverName;
  }
  readAll() {
    try {
      return JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
    } catch {
      return {};
    }
  }
  load() {
    return this.readAll().servers?.[this.serverName];
  }
  async save(state) {
    const all = this.readAll();
    all.servers = all.servers || {};
    all.servers[this.serverName] = state;
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(TOKENS_PATH, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(TOKENS_PATH, 0o600);
    } catch {}
  }
}

async function makeOAuthProvider(serverName, entry) {
  const { McpOAuthProvider } = await import("@earendil-works/pi-mcp/oauth");
  let authorizationUrl;
  const provider = new McpOAuthProvider({
    serverUrl: expandEnv(entry.url),
    redirectUrl: entry.oauth?.redirectUrl || "http://127.0.0.1/callback",
    clientMetadata: {
      client_name: entry.oauth?.clientName || "muse-mcp",
      ...(entry.oauth?.scope ? { scope: entry.oauth.scope } : {}),
    },
    store: new FileOAuthStateStore(serverName),
    onRedirect: (url) => {
      authorizationUrl = url.toString();
    },
  });
  return { provider, getAuthorizationUrl: () => authorizationUrl };
}

async function withClient(serverName, timeoutMs, fn) {
  const { servers, path } = loadRegistry();
  const entry = servers[serverName];
  if (!entry) throw new Error(`unknown server "${serverName}" in ${path}`);
  const client = new McpClient({
    name: "mcp-cli",
    version: "1.0.0",
    requestTimeoutMs: timeoutMs,
  });
  let transport;
  if (entry.transport === "streamable-http" || !entry.transport) {
    const { StreamableHttpTransport: T } = { StreamableHttpTransport };
    const opts = { url: expandEnv(entry.url) };
    if (entry.headers) opts.headers = expandMap(entry.headers);
    for (const k of ["openGetStream", "maxMessageBytes"]) {
      if (entry.options && entry.options[k] !== undefined) opts[k] = entry.options[k];
    }
    if (entry.oauth) {
      const { adaptOAuthProvider } = await import("@earendil-works/pi-mcp/oauth");
      const { provider } = await makeOAuthProvider(serverName, entry);
      opts.authProvider = adaptOAuthProvider(provider);
    }
    transport = new T(opts);
  } else if (entry.transport === "stdio") {
    if (!entry.command) throw new Error(`stdio server "${serverName}" needs "command"`);
    transport = new StdioTransport({
      command: expandEnv(entry.command),
      args: (entry.args || []).map(expandEnv),
      env: entry.env ? expandMap(entry.env) : undefined,
      inheritEnv: entry.inheritEnv ?? true,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
    });
  } else {
    throw new Error(`unsupported transport "${entry.transport}"`);
  }
  const started = Date.now();
  const init = await client.connect(transport);
  try {
    return await fn(client, { init, ms: Date.now() - started, entry });
  } finally {
    await client.close().catch(() => {});
  }
}

function summarizeInit(init) {
  return {
    server: init?.serverInfo ? `${init.serverInfo.name}@${init.serverInfo.version}` : null,
    protocolVersion: init?.protocolVersion ?? null,
  };
}

function authNeededMessage(server) {
  return `server "${server}" needs OAuth authorization — run: mcp auth --server ${server}`;
}

async function cmdSmoke() {
  const only = getArg("--server", null);
  const timeoutMs = Number(getArg("--timeout-ms", String(DEFAULT_TIMEOUT_MS)));
  const { servers } = loadRegistry();
  const names = only ? [only] : Object.keys(servers);
  const results = [];
  for (const name of names) {
    const r = { server: name, url: servers[name]?.url, ok: false };
    try {
      await withClient(name, timeoutMs, async (client, ctx) => {
        await client.ping();
        const tools = await client.listTools();
        r.ok = true;
        r.connectMs = ctx.ms;
        r.init = summarizeInit(ctx.init);
        r.toolCount = tools.length;
        r.tools = tools.map((t) => t.name);
      });
    } catch (e) {
      r.error =
        e?.name === "McpOAuthAuthorizationRequiredError"
          ? authNeededMessage(name)
          : `${e?.name ?? "Error"}: ${e?.message ?? e}`;
    }
    results.push(r);
    console.log(JSON.stringify(r));
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

async function cmdListTools() {
  const server = getArg("--server", null);
  if (!server) throw new Error("--server is required");
  const timeoutMs = Number(getArg("--timeout-ms", String(DEFAULT_TIMEOUT_MS)));
  await withClient(server, timeoutMs, async (client) => {
    const tools = await client.listTools();
    console.log(
      JSON.stringify(
        tools.map((t) => ({
          name: t.name,
          title: t.title ?? null,
          description: t.description ?? null,
          inputSchema: t.inputSchema,
        })),
        null,
        2,
      ),
    );
  });
}

async function cmdCallTool() {
  const server = getArg("--server", null);
  const name = getArg("--name", null);
  if (!server || !name) throw new Error("--server and --name are required");
  let args = {};
  const argsJson = getArg("--args-json", null);
  const argsFile = getArg("--args-file", null);
  if (argsJson) args = JSON.parse(argsJson);
  else if (argsFile) args = JSON.parse(readFileSync(resolve(argsFile), "utf8"));
  const timeoutMs = Number(getArg("--timeout-ms", String(DEFAULT_TIMEOUT_MS)));
  const asLlm = process.argv.includes("--llm");
  await withClient(server, timeoutMs, async (client) => {
    const result = await client.callTool(name, args);
    console.log(JSON.stringify(asLlm ? toLlmContent(result) : result, null, 2));
    if (result.isError) process.exitCode = 1;
  });
}

async function cmdListResources() {
  const server = getArg("--server", null);
  if (!server) throw new Error("--server is required");
  const timeoutMs = Number(getArg("--timeout-ms", String(DEFAULT_TIMEOUT_MS)));
  await withClient(server, timeoutMs, async (client) => {
    console.log(JSON.stringify(await client.listResources(), null, 2));
  });
}

async function cmdListResourceTemplates() {
  const server = getArg("--server", null);
  if (!server) throw new Error("--server is required");
  const timeoutMs = Number(getArg("--timeout-ms", String(DEFAULT_TIMEOUT_MS)));
  await withClient(server, timeoutMs, async (client) => {
    console.log(JSON.stringify(await client.listResourceTemplates(), null, 2));
  });
}

async function cmdReadResource() {
  const server = getArg("--server", null);
  const uri = getArg("--uri", null);
  if (!server || !uri) throw new Error("--server and --uri are required");
  const timeoutMs = Number(getArg("--timeout-ms", String(DEFAULT_TIMEOUT_MS)));
  await withClient(server, timeoutMs, async (client) => {
    console.log(JSON.stringify(await client.readResource(uri), null, 2));
  });
}

function cmdListServers() {
  const { servers, path } = loadRegistry();
  console.log(JSON.stringify({ registry: path, servers }, null, 2));
}

/**
 * Interactive OAuth PKCE flow:
 * dynamic client registration -> print authorization URL -> local callback
 * server waits for the redirect -> code exchange -> tokens saved to
 * ~/.config/mcp/tokens.json (0600) via FileOAuthStateStore.
 */
async function cmdAuth() {
  const server = getArg("--server", null);
  if (!server) throw new Error("--server is required");
  const { servers } = loadRegistry();
  const entry = servers[server];
  if (!entry) throw new Error(`unknown server "${server}"`);
  if (!entry.oauth) {
    throw new Error(`server "${server}" has no "oauth" config in the registry`);
  }
  const {
    McpOAuthProvider,
    OAuthCallbackServer,
    authorizeMcp,
    adaptOAuthProvider,
    McpOAuthAuthorizationRequiredError,
  } = await import("@earendil-works/pi-mcp/oauth");

  const callback = await OAuthCallbackServer.listen({ timeoutMs: 5 * 60 * 1000 });
  let authorizationUrl;
  const mkProvider = () =>
    new McpOAuthProvider({
      serverUrl: expandEnv(entry.url),
      redirectUrl: callback.redirectUrl,
      clientMetadata: {
        client_name: entry.oauth?.clientName || "muse-mcp",
        ...(entry.oauth?.scope ? { scope: entry.oauth.scope } : {}),
      },
      store: new FileOAuthStateStore(server),
      onRedirect: (url) => {
        authorizationUrl = url.toString();
      },
    });

  const tryConnect = async () => {
    const client = new McpClient({ name: "mcp-cli", version: "1.0.0", requestTimeoutMs: 60000 });
    const transport = new StreamableHttpTransport({
      url: expandEnv(entry.url),
      authProvider: adaptOAuthProvider(mkProvider()),
    });
    try {
      const init = await client.connect(transport);
      return { client, transport, init };
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  };

  try {
    try {
      const { client, transport, init } = await tryConnect();
      await client.close().catch(() => {});
      console.log(JSON.stringify({ server, ok: true, note: "already authorized", init: summarizeInit(init) }));
      return;
    } catch (e) {
      const needsAuth =
        e instanceof McpOAuthAuthorizationRequiredError || e?.name === "McpOAuthAuthorizationRequiredError";
      if (!needsAuth) throw e;
    }

    if (!authorizationUrl) throw new Error("OAuth provider did not produce an authorization URL");
    console.log(`\nOpen this URL in your browser to authorize "${server}":\n\n  ${authorizationUrl}\n`);
    console.log("Waiting for the callback (5 minutes)...");
    const oauth = mkProvider();
    const state = await oauth.state();
    const { code, iss } = await callback.waitForCallback(state);
    const result = await authorizeMcp(oauth, {
      serverUrl: expandEnv(entry.url),
      authorizationCode: code,
      iss,
    });
    console.log(`Authorization result: ${result}`);

    // Verify the grant works end to end.
    const { client, init } = await tryConnect();
    const tools = await client.listTools();
    await client.close().catch(() => {});
    console.log(
      JSON.stringify({
        server,
        ok: true,
        init: summarizeInit(init),
        toolCount: tools.length,
        note: `tokens saved to ${TOKENS_PATH}`,
      }),
    );
  } finally {
    await callback.close().catch(() => {});
  }
}

const cmd = process.argv[2];
try {
  if (cmd === "smoke") await cmdSmoke();
  else if (cmd === "list-tools") await cmdListTools();
  else if (cmd === "call-tool") await cmdCallTool();
  else if (cmd === "list-resources") await cmdListResources();
  else if (cmd === "list-resource-templates") await cmdListResourceTemplates();
  else if (cmd === "read-resource") await cmdReadResource();
  else if (cmd === "list-servers") cmdListServers();
  else if (cmd === "auth") await cmdAuth();
  else if (cmd === "--help" || cmd === "-h" || !cmd) {
    console.log(
      readFileSync(new URL(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 22)
        .join("\n")
        .replace(/^ \* ?/gm, ""),
    );
    process.exit(2);
  } else throw new Error(`unknown command "${cmd}"`);
} catch (e) {
  if (e?.name === "McpOAuthAuthorizationRequiredError") {
    console.error(`error: ${authNeededMessage(getArg("--server", "<name>"))}`);
  } else {
    console.error(`error: ${e?.message ?? e}`);
  }
  process.exit(1);
}
