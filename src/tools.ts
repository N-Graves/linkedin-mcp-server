import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  HttpClient,
  HttpError,
  ToolError,
  boundedText,
  type ToolDefinition,
} from "@nasdigitaluk/mcp-server-core";

/**
 * LinkedIn requires a YYYYMM version header on every /rest/* call and retires
 * versions after roughly a year — "roughly" being the operative word: 202512
 * was already retired while 202506 was still being sent.
 *
 * That staleness is not a soft failure. Every /rest/* call starts returning
 * 426 NONEXISTENT_VERSION, which means POST CREATION silently breaks, not just
 * whatever call happened to surface it. So the version is overridable without
 * a release (LINKEDIN_API_VERSION), and a 426 is turned into a message that
 * names the cause and the fix rather than a bare status.
 */
export const DEFAULT_LINKEDIN_VERSION = "202606";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

/** Turn LinkedIn's version failure into something actionable. */
function explainVersionFailure(err: unknown, version: string): never {
  if (err instanceof HttpError && err.status === 426) {
    throw new ToolError(
      `LinkedIn has retired API version ${version}, so every /rest/ call is failing — ` +
        `including post creation, not only whatever surfaced it. Set LINKEDIN_API_VERSION ` +
        `to a current YYYYMM version; LinkedIn retires them after roughly a year, and ` +
        `"roughly" has already proved unreliable.`,
    );
  }
  throw err;
}

export interface LinkedInOptions {
  version: string;
  /** Injected so the upload PUT is testable without reaching LinkedIn. */
  fetchImpl?: typeof fetch;
  uploadTimeoutMs?: number;
}

export function buildTools(http: HttpClient, opts: LinkedInOptions): ToolDefinition<any>[] {
  const restHeaders = {
    "X-Restli-Protocol-Version": "2.0.0",
    "LinkedIn-Version": opts.version,
  };
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  const me = async () => {
    const info = await http.get<{ sub: string }>("/v2/userinfo");
    if (!info?.sub) {
      throw new ToolError(
        "LinkedIn returned no member id from /v2/userinfo. The token is probably missing " +
          "the openid/profile scopes.",
      );
    }
    return `urn:li:person:${info.sub}`;
  };

  /**
   * LinkedIn's Images API is a three-step dance: initializeUpload hands back a
   * single-use uploadUrl AND the URN the image WILL have, the bytes are PUT to
   * that URL, and only then is the URN usable in a post.
   *
   * The URN arrives BEFORE the upload completes, so using it early attaches an
   * image that is not there yet. The upload also goes to a LinkedIn-supplied
   * absolute URL outside the API host and sends raw bytes rather than JSON,
   * which is why it is a direct fetch — with its own timeout, so it cannot
   * hang the tool call.
   */
  async function uploadImage(filePath: string, owner: string): Promise<string> {
    const ext = extname(filePath).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      throw new ToolError(
        `LinkedIn will not take a ${ext || "file with no extension"}. ` +
          `Supported: ${Object.keys(MIME_BY_EXT).join(", ")}.`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      // The path is echoed because the caller supplied it; nothing about the
      // host that is not already theirs.
      throw new ToolError(`Cannot read the image at ${basename(filePath)}.`);
    }

    const init = await http
      .post<{ value?: { uploadUrl?: string; image?: string } }>(
        "/rest/images",
        { initializeUploadRequest: { owner } },
        { action: "initializeUpload" },
        )
      .catch((e) => explainVersionFailure(e, opts.version));

    const uploadUrl = init?.value?.uploadUrl;
    const urn = init?.value?.image;
    if (!uploadUrl || !urn) {
      throw new ToolError("LinkedIn did not return an upload URL. Nothing was uploaded.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.uploadTimeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await doFetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: bytes as unknown as BodyInit,
        signal: controller.signal,
      });
    } catch {
      throw new ToolError("The image upload did not complete. Nothing was published.");
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new ToolError(
        `LinkedIn rejected the image upload (HTTP ${res.status}). Nothing was published.`,
      );
    }
    // Only now is the URN real.
    return urn;
  }

  return [
    {
      name: "linkedin_get_me",
      description: "The authenticated member — id, name and email if the token carries the scope.",
      action: "read",
      input: z.object({}),
      handler: () => http.get("/v2/userinfo"),
    },

    {
      name: "linkedin_create_post",
      description:
        "Publish to LinkedIn. ⚠️ There is NO draft state — LinkedIn's Posts API has no " +
        "unpublished lifecycle to fall back on, so this goes live the moment it succeeds. " +
        "Any human approval has to happen BEFORE this is called, never after.\n\n" +
        "An image is uploaded and confirmed first, so a picture LinkedIn rejects fails " +
        "before anything is published — a LinkedIn post cannot be edited afterwards to add " +
        "media.",
      action: "write",
      input: z.object({
        text: boundedText(3000).describe("Post commentary. LinkedIn's limit is 3000 characters."),
        visibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional().default("PUBLIC"),
        image_path: z
          .string()
          .optional()
          .describe("Local .png/.jpg/.gif to attach. Uploaded before the post is created."),
        image_alt_text: z.string().max(300).optional(),
      }),
      handler: async ({ text, visibility, image_path, image_alt_text }) => {
        const author = await me();
        const imageUrn = image_path ? await uploadImage(image_path, author) : null;

        const res = await http
          .requestWithMeta("/rest/posts", {
            method: "POST",
            headers: restHeaders,
            body: {
              author,
              commentary: text,
              visibility,
              distribution: {
                feedDistribution: "MAIN_FEED",
                targetEntities: [],
                thirdPartyDistributionChannels: [],
              },
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: false,
              ...(imageUrn
                ? { content: { media: { id: imageUrn, ...(image_alt_text ? { altText: image_alt_text } : {}) } } }
                : {}),
            },
          })
          .catch((e) => explainVersionFailure(e, opts.version));

        // The new post's URN comes back in a RESPONSE HEADER, not the body,
        // which is usually empty on a successful create. Reading only the body
        // means being unable to say what was just published.
        const postUrn = res.headers.get("x-restli-id");
        return {
          post_urn: postUrn,
          image_urn: imageUrn,
          url: postUrn ? `https://www.linkedin.com/feed/update/${postUrn}` : undefined,
          note: postUrn
            ? "Published and live."
            : "LinkedIn accepted the post but returned no id, so it cannot be linked to here.",
        };
      },
    },

    {
      name: "linkedin_delete_post",
      description: "Delete one of your own posts by URN. Irreversible.",
      action: "destructive",
      input: z.object({
        post_urn: z.string().min(1).describe("e.g. urn:li:share:7123456789"),
      }),
      handler: async ({ post_urn }) => {
        await http
          .request(`/rest/posts/${encodeURIComponent(post_urn)}`, {
            method: "DELETE",
            headers: restHeaders,
          })
          .catch((e) => explainVersionFailure(e, opts.version));
        return { deleted: true, post_urn };
      },
    },

    {
      name: "linkedin_call",
      description:
        "Call any LinkedIn endpoint directly. LinkedIn publishes no machine-readable spec, so " +
        "this server does not claim a complete catalogue — this is how you reach the rest of " +
        "the API. Paths are relative to https://api.linkedin.com. A /rest/ path automatically " +
        "gets the version and protocol headers.\n\n" +
        "⚠️ Comments are NOT reachable, whatever scopes you hold. See the README.",
      action: "destructive",
      input: z.object({
        path: z
          .string()
          .min(1)
          .refine((p) => p.startsWith("/"), "Path must start with /")
          .describe("e.g. /rest/posts or /v2/userinfo"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
      }),
      handler: ({ path, method, query, body }) =>
        http
          .request(path, {
            method,
            query: query ?? {},
            body,
            // A /rest/ call without these fails in ways that look like a
            // permission problem rather than a missing header.
            headers: path.startsWith("/rest/") ? restHeaders : undefined,
          })
          .catch((e) => explainVersionFailure(e, opts.version)),
    },
  ];
}
