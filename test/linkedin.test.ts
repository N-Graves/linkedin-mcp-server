import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpClient } from "@nasdigital/mcp-server-core";
import { buildTools, DEFAULT_LINKEDIN_VERSION } from "../src/tools.js";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

function harness(respond: (url: string, opts: RequestInit) => Response) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
  const record = (async (url: string, opts: RequestInit = {}) => {
    calls.push({
      url,
      method: opts.method ?? "GET",
      headers: (opts.headers ?? {}) as Record<string, string>,
      body: opts.body,
    });
    return respond(url, opts);
  }) as unknown as typeof fetch;

  const http = new HttpClient({
    baseUrl: "https://api.linkedin.com",
    headers: { Authorization: "Bearer fake" },
    fetchImpl: record,
  });
  const tools = buildTools(http, {
    version: DEFAULT_LINKEDIN_VERSION,
    fetchImpl: record,
    uploadTimeoutMs: 1000,
  });
  return { calls, tool: (n: string) => tools.find((t) => t.name === n)!, tools };
}

/** The happy path: identify, then create, with the URN in a response header. */
const publishOk = (url: string) => {
  if (url.includes("/v2/userinfo")) return json({ sub: "abc" });
  if (url.includes("/rest/posts"))
    return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:9" } });
  return json({});
};

describe("posting", () => {
  it("returns the post URN from the response header, not the body", async () => {
    // LinkedIn puts it in x-restli-id and leaves the body empty. Reading only
    // the body means being unable to say what was just published.
    const { tool } = harness(publishOk);
    const res = (await tool("linkedin_create_post").handler({
      text: "hello",
      visibility: "PUBLIC",
    })) as { post_urn: string; url: string };
    expect(res.post_urn).toBe("urn:li:share:9");
    expect(res.url).toContain("urn:li:share:9");
  });

  it("sends the version and protocol headers on /rest calls", async () => {
    // Without these a /rest call fails in a way that reads like a permission
    // problem rather than a missing header.
    const { tool, calls } = harness(publishOk);
    await tool("linkedin_create_post").handler({ text: "hi", visibility: "PUBLIC" });
    const post = calls.find((c) => c.url.includes("/rest/posts"))!;
    expect(post.headers["LinkedIn-Version"]).toBe(DEFAULT_LINKEDIN_VERSION);
    expect(post.headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
  });

  it("explains a retired API version instead of reporting a bare 426", async () => {
    // A stale version breaks post creation itself, not just whatever call
    // happened to surface it - so the message has to name the real cause.
    const { tool } = harness((url) =>
      url.includes("/v2/userinfo")
        ? json({ sub: "abc" })
        : new Response("nope", { status: 426 }),
    );
    await expect(
      tool("linkedin_create_post").handler({ text: "hi", visibility: "PUBLIC" }),
    ).rejects.toThrow(/retired API version[\s\S]*LINKEDIN_API_VERSION/);
  });

  it("says plainly that a post is live rather than implying a draft", () => {
    const { tool } = harness(publishOk);
    expect(tool("linkedin_create_post").description).toMatch(/NO draft state/);
    expect(tool("linkedin_create_post").action).toBe("write");
  });
});

describe("image upload", () => {
  const withImage = (dir: string) => {
    const file = join(dir, "a.png");
    writeFileSync(file, Buffer.from([1, 2, 3]));
    return file;
  };

  it("uploads and confirms the image BEFORE publishing anything", async () => {
    // A LinkedIn post cannot be edited afterwards to add media, so an image
    // LinkedIn rejects must fail before the post exists.
    const dir = mkdtempSync(join(tmpdir(), "li-"));
    try {
      const order: string[] = [];
      const { tool } = harness((url, opts) => {
        if (url.includes("/v2/userinfo")) return json({ sub: "abc" });
        if (url.includes("/rest/images")) {
          order.push("init");
          return json({ value: { uploadUrl: "https://upload.test/x", image: "urn:li:image:1" } });
        }
        if (url.startsWith("https://upload.test")) {
          order.push(`put:${(opts.headers as Record<string, string>)["Content-Type"]}`);
          return new Response("", { status: 201 });
        }
        order.push("post");
        return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:9" } });
      });

      const res = (await tool("linkedin_create_post").handler({
        text: "hi",
        visibility: "PUBLIC",
        image_path: withImage(dir),
      })) as { image_urn: string };

      expect(order).toEqual(["init", "put:image/png", "post"]);
      expect(res.image_urn).toBe("urn:li:image:1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not publish when the upload fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "li-"));
    try {
      const { tool, calls } = harness((url) => {
        if (url.includes("/v2/userinfo")) return json({ sub: "abc" });
        if (url.includes("/rest/images"))
          return json({ value: { uploadUrl: "https://upload.test/x", image: "urn:li:image:1" } });
        if (url.startsWith("https://upload.test")) return new Response("", { status: 500 });
        return new Response("", { status: 201 });
      });
      await expect(
        tool("linkedin_create_post").handler({
          text: "hi",
          visibility: "PUBLIC",
          image_path: withImage(dir),
        }),
      ).rejects.toThrow(/Nothing was published/);
      expect(calls.filter((c) => c.url.includes("/rest/posts"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file type LinkedIn will not take, before reading it", async () => {
    const { tool, calls } = harness(publishOk);
    await expect(
      tool("linkedin_create_post").handler({
        text: "hi",
        visibility: "PUBLIC",
        image_path: "/tmp/whatever.bmp",
      }),
    ).rejects.toThrow(/\.png/);
    expect(calls.filter((c) => c.url.includes("/rest/"))).toHaveLength(0);
  });
});

describe("passthrough", () => {
  it("adds the version headers to a /rest path and not to a /v2 one", async () => {
    const { tool, calls } = harness(() => json({}));
    await tool("linkedin_call").handler({ path: "/rest/posts", method: "GET" });
    await tool("linkedin_call").handler({ path: "/v2/userinfo", method: "GET" });
    expect(calls[0]!.headers["LinkedIn-Version"]).toBe(DEFAULT_LINKEDIN_VERSION);
    expect(calls[1]!.headers["LinkedIn-Version"]).toBeUndefined();
  });

  it("refuses a path that is not a path", () => {
    const { tool } = harness(() => json({}));
    expect(tool("linkedin_call").input.safeParse({ path: "https://evil.test" }).success).toBe(false);
  });

  it("warns in its own description that comments are unreachable", () => {
    // Somebody should not have to discover the Partner Program gate after
    // their post is already public.
    const { tool } = harness(() => json({}));
    expect(tool("linkedin_call").description).toMatch(/Comments are NOT reachable/);
  });
});
