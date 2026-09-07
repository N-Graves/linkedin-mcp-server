# linkedin-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **LinkedIn API**.

MIT licensed.

## Install

```bash
npm install -g @nasdigital/linkedin-mcp
```

## Configuration

```json
{
  "env": {
    "LINKEDIN_ACCESS_TOKEN": "your-token",
    "LINKEDIN_API_VERSION": "202606"
  }
}
```

`LINKEDIN_API_VERSION` is optional; it overrides the pinned default. Read on for why it exists.

A token can be obtained from LinkedIn's own OAuth Token Generator in the developer portal — no need to build a redirect flow for a single-account integration.

## ⚠️ Comments are unreachable, and no scope fixes it

Both directions of the comments API return `403 ACCESS_DENIED`:

```
partnerApiSocialActions.CREATE.20260601
partnerApiSocialActions.GET_ALL.20260601
```

That is the **LinkedIn Partner Program** gate, not a missing scope — it happens with `w_member_social` already granted, which LinkedIn's own documentation implies is sufficient. It is not, for a standard app.

This server therefore ships **no comment tool**. A tool that fails only *after* the post is already public is worse than not having one: the usual pattern for LinkedIn is to put the outbound link in the first comment, and discovering at that moment that you cannot is the worst possible time. Post the comment by hand.

It is written down here so nobody has to rediscover it against a live account.

## ⚠️ The version header is a time bomb, so it is configurable

Every `/rest/*` call needs a `LinkedIn-Version: YYYYMM` header, and LinkedIn retires versions after **roughly** a year. "Roughly" is doing real work in that sentence: `202512` was already retired while `202506` was still being sent.

When it goes stale, every `/rest/*` call returns `426 NONEXISTENT_VERSION` — which means **post creation is broken**, not merely whatever call happened to surface it.

So:

- the version is overridable with `LINKEDIN_API_VERSION`, no release needed;
- a `426` is turned into a message naming the cause and the fix, rather than a bare status.

## ⚠️ There is no draft state

LinkedIn's Posts API has no unpublished lifecycle. A successful create is **immediately live**. Any human approval step has to happen *before* `linkedin_create_post` is called — there is nothing to review afterwards except a post that is already out.

## Images: three steps, in the right order

LinkedIn's Images API hands back a single-use `uploadUrl` **and the URN the image will have** before the bytes have been uploaded. Using that URN early attaches an image that is not there yet.

Here the sequence is: initialise, PUT the bytes, confirm, *then* create the post. An image LinkedIn rejects fails **before anything is published**, which matters because a LinkedIn post cannot be edited afterwards to add media.

The byte upload goes to a LinkedIn-supplied absolute URL outside the API host and sends raw bytes rather than JSON, so it is a direct `fetch` — with its own timeout, so it cannot hang the tool call.

## The post URN comes back in a header

A successful create returns an empty body and puts the new post's URN in the `x-restli-id` **response header**. A client that only reads bodies cannot tell you what it just published, so this one reads the header and hands back the URN and a link.

## Tools

| Tool | |
|---|---|
| `linkedin_get_me` | The authenticated member. |
| `linkedin_create_post` | Publish. Immediately live, no draft. |
| `linkedin_delete_post` | Delete your own post. Irreversible. |
| `linkedin_call` | Anything else on the API. |

## What is NOT covered

LinkedIn publishes no machine-readable spec, and much of its API is gated behind partner programmes that no amount of scope-granting opens. So this server does **not** claim complete coverage — it wraps what a standard developer app can verifiably do, and offers `linkedin_call` as a documented passthrough for the rest.

Claiming a complete catalogue here would be a claim that cannot be checked and would quietly stop being true.

## Read-only and no-destructive modes

```
MCP_READ_ONLY=1       refuse anything that changes state
MCP_NO_DESTRUCTIVE=1  allow posting, refuse deletes
```

## Testing

```bash
npm test                                              # 10 tests
SMOKE_ENV='{"LINKEDIN_ACCESS_TOKEN":"x"}' npm run smoke   # real MCP over stdio
```

## Built on

[`@nasdigital/mcp-server-core`](https://github.com/N-Graves/mcp-server-core).

## Licence

MIT.
