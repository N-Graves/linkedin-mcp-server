#!/usr/bin/env node
/**
 * linkedin-mcp-server — a Model Context Protocol server for the LinkedIn API.
 *
 * Configuration:
 *   LINKEDIN_ACCESS_TOKEN  required.
 *   LINKEDIN_API_VERSION   optional. YYYYMM, defaults to a pinned recent one.
 *   LINKEDIN_BASE_URL      optional. Defaults to https://api.linkedin.com
 *   MCP_READ_ONLY=1        refuse anything that changes state.
 *   MCP_NO_DESTRUCTIVE=1   allow posting, refuse deletes.
 *
 * ⚠️  Posting has no draft state. LinkedIn's Posts API has no unpublished
 *     lifecycle, so a successful create is immediately live. Any human
 *     approval belongs BEFORE the call.
 *
 * ⚠️  Comments are unreachable behind the Partner Program, whatever scopes the
 *     token holds. That is stated in the README rather than shipped as a tool
 *     that fails after the post is already public.
 */

import { authorizerFromEnv, requireEnv, runServer, HttpClient } from "@nasdigitaluk/mcp-server-core";
import { buildTools, DEFAULT_LINKEDIN_VERSION } from "./tools.js";

const VERSION = "1.0.0";

async function main() {
  const token = requireEnv("LINKEDIN_ACCESS_TOKEN");
  const apiVersion = process.env.LINKEDIN_API_VERSION || DEFAULT_LINKEDIN_VERSION;

  const http = new HttpClient({
    baseUrl: process.env.LINKEDIN_BASE_URL || "https://api.linkedin.com",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": `linkedin-mcp-server/${VERSION}`,
    },
    timeoutMs: 30_000,
  });

  const tools = buildTools(http, { version: apiVersion });
  await runServer({
    name: "linkedin-mcp-server",
    version: VERSION,
    authorizer: authorizerFromEnv(),
    tools,
  });

  console.error(
    `LinkedIn API version ${apiVersion}: ${tools.length} tools. ` +
      `Versions are retired after roughly a year - set LINKEDIN_API_VERSION if calls start ` +
      `returning 426.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
