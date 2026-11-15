---
title: API requests
description: REST and GraphQL requests, pagination, conditional requests, retries and rate limits.
---

## REST

`Api.json(request, schema)` decodes one JSON response. `Api.empty(request)` runs a request whose body isn't needed, such as a 204 mutation. `Api.text(request)` returns the body as text, and `Api.headers(request)` returns the response headers with lower-cased names. `Api.raw(request)` returns the buffered output and exit code. Every request names its method.

```ts
import { Api } from "@timmo001/effect-gh";
import { Schema } from "effect";

const viewer = Api.json(
  { endpoint: "user", method: "GET" },
  Schema.Struct({ login: Schema.String }),
);
```

Requests accept `hostname`, `headers`, `query`, a JSON `body` and core overrides under `options`. JSON bodies go through stdin rather than CLI field interpolation.

`Api.pages(request, pageSchema)` runs a bodyless GET with `--paginate --slurp` and returns an array of decoded pages, not flattened items.

`Api.conditional(request, schema, validators?)` sends the `etag` and `lastModified` from an earlier response and returns `Modified` or `NotModified`. A 304 costs no primary rate limit.

## GraphQL

`Graphql.query(document, variables, schema, options?)` posts through `gh api graphql` and decodes `data`. A response with `errors` fails with `GraphqlResponseError`.

`Graphql.operations(document)` parses a document without running it and returns each operation's kind, name and top-level fields, so you can tell reads from writes.

## Retries

No operation retries automatically, because a mutation may have taken effect even when the CLI times out. `Gh.retryTransient(options?)` retries known-transient failures: timeouts, rate limits, HTTP 408, 429 and 5xx statuses, and network failures. It defaults to three retries with jittered exponential backoff.

```ts
import { Api, Gh } from "@timmo001/effect-gh";
import { Schema } from "effect";

const viewer = Api.json(
  { endpoint: "user", method: "GET" },
  Schema.Struct({ login: Schema.String }),
).pipe(Gh.retryTransient({ times: 2 }));
```

## Rate limits

`RateLimit.get(resource?, options?)` reads the `core`, `graphql` or `search` quota, which doesn't count against it. `RateLimit.cached` caches those reads and `RateLimit.guard` waits for the reset, or fails with `RateLimitExhausted`, once the remaining requests run low.
