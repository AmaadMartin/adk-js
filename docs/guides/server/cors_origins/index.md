# CORS origins for the dev server

`adk web` and `adk api_server` accept one `--allow_origins` value. Prefix that
value with `regex:` to accept a family of origins with one pattern instead of a
single literal origin.

## Introduction

A browser sends an `Origin` header on a cross-origin request, and the server
answers with `Access-Control-Allow-Origin` when it accepts that origin. The dev
server takes the origin it accepts from `--allow_origins` (the `allowOrigins`
option on `AdkApiServer`).

A literal origin is one exact string, so a deployment that serves each tenant
from its own subdomain cannot name them all. An entry prefixed with `regex:`
holds a regular expression instead, and the server accepts any origin the
pattern matches in full. This mirrors adk-python, where `--allow_origins` takes
the same prefix.

Two neighbouring pieces read the same option, and neither changes here. The
`cors` middleware decides which origins get a CORS header. The DNS-rebinding
guard derives the `Host` values it accepts from `--allow_origins`; a `regex:`
entry names no single host, so it widens the guard for nothing. Use
`--allowed_hosts` to name a host behind a proxy.

## Get started

Serve every tenant subdomain of `myapp.com`:

```shell
adk web ./agents --allow_origins 'regex:https://tenant-.*\.myapp\.com'
```

The same option on the server class:

```ts
import {AdkApiServer} from '@google/adk-devtools';

const server = new AdkApiServer({
  agentsDir: './agents',
  allowOrigins: 'regex:https://tenant-.*\\.myapp\\.com',
});
await server.start();
```

`https://tenant-a.myapp.com` now gets a CORS header, and
`https://other.example` does not.

## Matching rules

- An entry without the prefix is a literal origin, compared exactly.
- `*` accepts every origin. The server answers `Access-Control-Allow-Origin: *`.
- A pattern must match the whole origin. `regex:https://.*\.myapp\.com` accepts
  `https://tenant-a.myapp.com` and refuses `https://tenant-a.myapp.com.evil.com`.
- An entry of exactly `regex:` holds no pattern and is dropped.
- An invalid pattern throws a `SyntaxError` when the server starts.

## The AdkWebServer alias

`AdkWebServer` is the former name of `AdkApiServer`. It still constructs a
working server and logs one deprecation warning, so code written before the
rename keeps running. Use `AdkApiServer` in new code.
