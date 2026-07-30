# Dependency duplication: `google-auth-library`

## Why this file exists

`adk-js` knowingly ships more than one copy of `google-auth-library`. The
duplication is not an oversight, and it cannot be removed by forcing every
dependent onto the hoisted version:
`@google-cloud/opentelemetry-cloud-trace-exporter` would keep compiling and keep
running while sending no credentials at all, and `@google-cloud/storage` would
break for one credential type and silently drop a request header. This file
records the
per-dependent analysis so it does not have to be redone, and
`tests/integration/dependencies/google_auth_library_duplication_test.ts` turns
the conclusions into an assertion that fails when the set of copies changes.

## Current state

`@google/adk` (`core/package.json`) declares `google-auth-library: ^10.3.0`. It
is the only workspace that declares the package, and it uses it in
`core/src/telemetry/google_cloud.ts`,
`core/src/integrations/agent_registry/agent_registry.ts` and
`core/src/tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.ts`.
Six transitive dependents still declare a `^9.x` range, so npm nests a v9 copy
under each of them:

```
$ npm ls google-auth-library --all
adk@1.4.0
└─┬ @google/adk@1.4.0 -> ./core
  ├─┬ @google-cloud/opentelemetry-cloud-monitoring-exporter@0.21.0
  │ ├── google-auth-library@9.15.1
  │ └─┬ googleapis@137.1.0
  │   ├── google-auth-library@9.15.1
  │   └─┬ googleapis-common@7.2.0
  │     └── google-auth-library@9.15.1
  ├─┬ @google-cloud/opentelemetry-cloud-trace-exporter@3.0.0
  │ └── google-auth-library@9.15.1
  ├─┬ @google-cloud/storage@7.21.0
  │ └── google-auth-library@9.15.1
  ├─┬ @google-cloud/vertexai@1.12.0
  │ ├─┬ @google/genai@1.52.0
  │ │ └── google-auth-library@10.7.0 deduped
  │ └── google-auth-library@9.15.1
  ├─┬ @google/genai@2.9.0
  │ └── google-auth-library@10.7.0 deduped
  └── google-auth-library@10.7.0
```

As the indentation shows, `googleapis` and `googleapis-common` are reached only
through `@google-cloud/opentelemetry-cloud-monitoring-exporter` (`googleapis
^137.0.0` -> `googleapis-common ^7.0.0`), so those two cannot be decided
independently of it.

The cost is not only the second copy. v9's `gaxios@6.7.1`, `gcp-metadata@6.1.1`,
`gtoken@7.1.0` and `google-logging-utils@0.0.2` sit alongside v10's
`gaxios@7.1.5`, `gcp-metadata@8.1.2` and `google-logging-utils@1.1.3` (v10
vendors `gtoken`), and each `gaxios` brings its own `node-fetch`, `2.7.0` and
`3.3.2` respectively.

## The v9 -> v10 changes that matter

Diffing `build/src/index.d.ts` between `google-auth-library@9.15.1` and
`@10.7.0`, the only removed top-level export is `DefaultTransporter` (v10
deletes `build/src/transporters.*`). v10 adds `GdchClient`,
`ExternalAccountAuthorizedUserClient` and their option types. `GoogleAuth`,
`OAuth2Client`, `JWT`, `Compute` and `DEFAULT_UNIVERSE` are unchanged.

The export list is not where the risk is. Two behavioural changes keep the same
name in both majors, so a symbol-level compatibility check passes while the
runtime behaviour does not:

1. `getRequestHeaders()` changed its return value from a plain object to a
   WHATWG `Headers` instance. In v9,
   `build/src/auth/authclient.d.ts` types it `Promise<Headers>` where `Headers`
   is v9's own `interface Headers { [index: string]: string }` from
   `build/src/auth/oauth2client.d.ts`. In v10 the same name resolves to the
   global `Headers` class, which exposes nothing as an own property:

   ```
   const h = new Headers({authorization: 'Bearer TOKEN'});
   Object.keys(h)         -> []
   Object.assign({}, h)   -> {}
   h['authorization']     -> undefined
   h.get('authorization') -> 'Bearer TOKEN'
   ```

   Any consumer that reads the result as a plain object therefore sees no
   headers at all, with no error.

2. `GoogleAuth#authorizeRequest()` stopped honouring `opts.uri`. v9
   (`build/src/auth/googleauth.js:740`) reads `opts.url || opts.uri` and merges
   with `Object.assign(opts.headers || {}, headers)`; v10
   (`build/src/auth/googleauth.js:819`) reads `opts.url` only and merges with
   `Gaxios.mergeHeaders(opts.headers, headers)`. A caller that passes `{uri}`
   loses the URL and receives a `Headers` instance back.

## Per-dependent verdict

| Dependent                                               | Declares `google-auth-library` | Dependent's latest release | Verdict         | Why                                                                                                      |
| ------------------------------------------------------- | ------------------------------ | -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `@google-cloud/opentelemetry-cloud-trace-exporter`      | `^9.0.0`                       | `3.0.0`                    | Keep            | gRPC reads the auth headers as a plain object; v10 would drop `Authorization`.                           |
| `@google-cloud/opentelemetry-cloud-monitoring-exporter` | `^9.0.0`                       | `0.21.0`                   | Keep            | Hands its auth client to `googleapis-common`, which expects the v9 contract.                             |
| `googleapis`                                            | `^9.0.0`                       | `173.0.0`                  | Keep            | Not a direct dependency; the v10-era releases nest a copy through `googleapis-common`.                   |
| `googleapis-common`                                     | `^9.7.0`                       | `9.0.0`                    | Keep            | Constructs `DefaultTransporter`, which v10 removed.                                                      |
| `@google-cloud/storage`                                 | `^9.6.3`                       | `7.21.0`                   | Keep            | Sends `uri`, which v10's `authorizeRequest()` ignores, and then writes to the headers as a plain object. |
| `@google-cloud/vertexai`                                | `^9.1.0`                       | `1.12.0`                   | Separate change | Handled by a dependent-scoped override outside this analysis.                                            |

The "latest release" column is what `npm view <dependent> version` reported when
this file was written. Three of the five kept dependents are already at their
latest release, so upgrading is not available to them at all. The other two,
`googleapis` and `googleapis-common`, do have newer releases; the sections below
explain why those are not a route out either.

## Per-dependent detail

### `@google-cloud/opentelemetry-cloud-trace-exporter@3.0.0`

`build/src/trace.js` uses only `new GoogleAuth({...})`, `getProjectId()` and
`getClient()`, all of which exist unchanged in v10. The problem is what it does
with the client at `trace.js:124-131`:

```js
const creds = await this._auth.getClient();
...
const callCreds = grpc.credentials.createFromGoogleCredential(creds);
```

`@grpc/grpc-js` (resolved at `1.14.4` here) implements that in
`build/src/call-credentials.js:66-70` by iterating the result of
`getRequestHeaders()` as a plain object:

```js
getHeaders.then(headers => {
  const metadata = new metadata_1.Metadata();
  for (const key of Object.keys(headers)) {
    metadata.add(key, headers[key]);
  }
  callback(null, metadata);
}, ...)
```

Driving that code path against the installed `@grpc/grpc-js@1.14.4` with each
header shape:

| `getRequestHeaders()` returns                              | resulting gRPC metadata              |
| ---------------------------------------------------------- | ------------------------------------ |
| `{authorization: 'Bearer TOKEN'}` (v9 shape)               | `{"authorization":["Bearer TOKEN"]}` |
| `new Headers({authorization: 'Bearer TOKEN'})` (v10 shape) | `{}`                                 |

Forcing this exporter onto v10 would strip the `Authorization` header from
every Cloud Trace export. There is no compile error and no exception; the only
symptom is server-side `UNAUTHENTICATED` and dropped spans. This is why a
blanket `google-auth-library` override is not an acceptable fix.

### `@google-cloud/opentelemetry-cloud-monitoring-exporter@0.21.0`

`build/src/monitoring.js` builds its own `GoogleAuth`, then passes the resulting
client out of its own copy and into another package:

```js
async _authorize() { return (await this._auth.getClient()); }
...
await this._monitoring.projects.timeSeries.create({
  name: ..., requestBody: {timeSeries}, auth: authClient,
});
```

`googleapis-common@7.2.0` consumes that `auth` value in
`build/src/apirequest.js:289-303`, written against the v9 client contract. It
calls `authClient.getUniverseDomain()`, then branches on `options.http2`. The
exporter never sets `http2`, so the branch taken here is
`authClient.request(options)` — a v10 client handed a `gaxios@6`-shaped options
object. The other branch,
`Object.assign(mooOpts.headers, await authClient.getRequestHeaders(options.url))`,
is the silent-header-drop shape from the table above; it is unreachable from
this exporter today, but nothing prevents a caller from enabling it.

Because the auth client crosses a package boundary, this row is coupled to
`googleapis` and `googleapis-common`. It cannot move to v10 while they stay on
v9-era code.

### `googleapis@137.1.0`

An upgrade exists: `149.0.0` still declares `google-auth-library ^9.0.0`, while
`150.0.1` declares `^10.0.0-rc.1`, `152.0.0` declares `^10.1.0` and `173.0.0`
(the current latest) declares `^10.2.0`. It is still not a usable route, for
three independent reasons:

- It is not a direct dependency. The monitoring exporter declares
  `googleapis: ^137.0.0`, so even the earliest v10-declaring release means
  overriding it 13 majors past its declared range (`150.0.1`), and the latest
  36 (`173.0.0`).
- The exporter deep-imports an unpublished path: `monitoring.js:20` does
  `require("googleapis/build/src/apis/monitoring")`. `googleapis` declares no
  `exports` map, so nothing constrains that path across releases.
- The upgrade would not remove the duplicate, because of the exact pin described
  under `googleapis-common` below. Every v10-declaring release resolves
  `googleapis-common` to the `8.x` line, so the two nested v9 copies in this
  subtree become one nested `10.5.0` — an improvement, but still a duplicate,
  and one that a further override would have to chase.

### `googleapis-common@7.2.0`

This is the only row that is statically incompatible with v10. It references
`DefaultTransporter`, the export v10 removed, in its public type surface and at
two constructor sites:

```
build/src/index.d.ts:1      export { ..., DefaultTransporter, ... } from 'google-auth-library';
build/src/discovery.js:30       this.transporter = new google_auth_library_1.DefaultTransporter();
build/src/apirequest.js:307     return new google_auth_library_1.DefaultTransporter().request(options);
```

Be precise about reachability. `build/src/index.js:21` re-exports
`DefaultTransporter` through a lazy getter, so a v10 override would not crash at
import time, and neither call site is on a path `adk-js` currently exercises:
the monitoring exporter always supplies `auth`, so `apirequest.js` takes the
`authClient` branch, and discovery is unused. The objection is that an override
would knowingly ship a dependency graph containing a latent `TypeError` on a
branch the application does not control.

Upgrading does not help either: `googleapis-common@8.0.3` and `@9.0.0` both pin
`google-auth-library: 10.5.0` exactly, so against a hoisted `10.7.0` the
upgrade trades one nested copy for another. `9.0.0` additionally requires Node
`>=22`. This pin is what also blocks the `googleapis` upgrade above.

### `@google-cloud/storage@7.21.0`

Symbol usage is narrow (`DEFAULT_UNIVERSE`, `GoogleAuth`) and both exist in v10,
so a symbol-level check passes. The behaviour does not.
`build/cjs/src/nodejs-common/util.js:501` calls:

```js
return authClient.authorizeRequest(reqOpts);
```

`reqOpts` in this package is `request`-style and carries `uri`, not `url` — see
`nodejs-common/util.js:643` (`reqOpts.uri = replaceProjectIdToken(reqOpts.uri, projectId)`)
and `nodejs-common/service.js:138-165`, which assembles the request URL into
`reqOpts.uri`. Under v10 that has two consequences:

- `authorizeRequest()` reads only `opts.url`, so the URL is `undefined`. For a
  self-signed-JWT service-account credential the URL is the JWT audience, which
  makes this a credential-type-dependent auth failure rather than a uniform one.
- The returned `opts.headers` is a `Headers` instance, which flows into
  `teeny-request@9.0.0`. Its `build/src/index.js:44` does
  `reqOpts.headers['Content-Type'] = 'application/json'`. On a `Headers`
  instance that lands as an ordinary own property and never reaches the header
  list, so the content type is dropped.

`util.js:387` also branches on
`googleAutoAuthConfig.authClient instanceof google_auth_library_1.GoogleAuth`,
resolved against this package's own copy, so a caller-supplied `GoogleAuth` from
a different copy takes the other branch. `adk-js` does not hit that today —
`core/src/artifacts/gcs_artifact_service.ts` forwards only `StorageOptions` to
`new Storage(...)` — but the branch exists.

## Re-check protocol

Follow this before changing any row above, and before adding a row for a new
nested copy.

1. Prefer an upgrade over an override: `npm view <dependent> versions --json`,
   and check what a v10-declaring release does to the rest of the graph. An
   upgrade that swaps a nested v9 for a nested v10 is not progress.
2. `npm pack <dependent>@<version>` and diff the `google-auth-library` symbols
   the emitted `build/`/`dist/` references against the v9 and v10
   `build/src/index.d.ts`. **Necessary but not sufficient** — the trace exporter
   and `@google-cloud/storage` both pass this step and still break. Also trace
   where the package hands its `AuthClient`, or the result of
   `getRequestHeaders()`, to another package, and read what the receiver does
   with it.
3. Exercise the real code path at runtime, and run `tsc --noEmit` with this
   repo's compiler options.
4. Only then add the override, and update both the allowlist in
   `tests/integration/dependencies/google_auth_library_duplication_test.ts` and
   the matching section here, in the same change.

Three npm behaviours (seen with npm 9.2.0) make step 4 slower than it looks:

- Adding an `overrides` entry and running `npm install` reports `up to date` and
  changes nothing, because a satisfying lockfile already exists; the subsequent
  `npm ls` then fails with `ELSPROBLEMS ... overridden`. Delete the nested
  `node_modules/<dependent>/node_modules/...` entries from `package-lock.json`
  by hand first, then reinstall.
- Do not `rm package-lock.json` and reinstall instead. A from-scratch resolve
  churns hoisting across hundreds of unrelated packages.
- Verify with a real `npm install` plus `npm ls <pkg> --all` (exit code `0`).
  `npm install --package-lock-only` accepts hand-edited lockfiles that no real
  install would produce, and npm 9.x does not write `overrides` into the
  lockfile, so its absence there proves nothing.
