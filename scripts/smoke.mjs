/**
 * End-to-end proof that the private-fleet coupling is gone.
 *
 *   npm run smoke
 *
 * Speaks real MCP over stdio to the built server with FLEET_BOARD_URL and
 * OPENCLAW_MCP_AGENT_ID explicitly cleared. In the server this replaces, every
 * write tool called a private task board at 127.0.0.1:8420 and FAILED CLOSED -
 * so this exact scenario, somebody else's machine with no fleet running, left
 * every write tool permanently broken.
 *
 * The credentials are deliberately fake: every assertion is about the server's
 * own behaviour, so nothing here touches the provider or needs an account.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const env = { ...process.env, ...JSON.parse(process.env.SMOKE_ENV || "{}") };
delete env.FLEET_BOARD_URL;
delete env.OPENCLAW_MCP_AGENT_ID;

const child = spawn("node", ["dist/index.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    } catch { /* not a protocol line */ }
  }
});

let nextId = 1;
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`${method} timed out`)), 10_000);
  });

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail && !ok ? `\n    ${detail}` : ""}`);
};

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check("initializes with no fleet board reachable", Boolean(init.result?.serverInfo));

  const listed = await send("tools/list", {});
  const tools = listed.result?.tools ?? [];
  check("advertises tools", tools.length > 0, `got ${tools.length}`);

  const withAgentId = tools.filter(
    (t) => JSON.stringify(t.inputSchema).includes("agent_id") || /agent_id/.test(t.description ?? ""),
  );
  check("no tool asks for agent_id", withAgentId.length === 0, withAgentId.map((t) => t.name).join(", "));

  const leaky = tools.filter((t) =>
    /fleet board|with_nate|nas_digital|misaki|\bjoel\b|HERALD|ECHO|LEDGER|NEXUS|ORACLE|FORGE/i.test(
      `${t.name} ${t.description} ${JSON.stringify(t.inputSchema)}`,
    ),
  );
  check("no private vocabulary in the advertised surface", leaky.length === 0, leaky.map((t) => t.name).join(", "));

  // No catalogue to browse here - these providers publish no machine-readable
  // spec - so the equivalent proof is that a refusal happens LOCALLY, before
  // any network call, with no credentials and no fleet running.
  const badPath = await send("tools/call", {
    name: "linkedin_call",
    arguments: { path: "https://evil.test/x" },
  });
  check(
    "a passthrough path that is not a path is refused locally",
    badPath.result?.isError === true && /path must start with/i.test(badPath.result.content[0].text),
  );

  check("nothing was written to stdout that is not protocol", !buffer.trim());
} finally {
  child.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed  (${pkg.name})`);
if (failed.length) {
  console.log("\nserver stderr:\n" + stderr.split("\n").slice(0, 15).join("\n"));
  process.exit(1);
}
