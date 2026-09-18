# BigQuery tool config

`BigQueryToolConfig` holds the guardrails a BigQuery tool runs under: which
write operations are allowed, how much a query may cost, how many rows it
returns, and which labels its jobs carry. Reach for it when you want an agent
to read from BigQuery without being able to change it, or when you must cap
what a model-authored query can spend.

## Introduction

A BigQuery tool takes a query the model wrote. That query is attacker-
influenced input, so the interesting decisions are the ones you make before
the model runs: whether a write is allowed at all, and what a single query may
cost you.

`WriteMode` covers the first decision. `BLOCKED`, the default, permits only
read operations. `PROTECTED` permits writes inside a BigQuery
[session's](https://cloud.google.com/bigquery/docs/sessions-intro) anonymous
dataset, so the model can create and drop temporary tables while your
permanent tables stay untouched. `ALLOWED` permits every write.

`maximumBytesBilled` covers the second. BigQuery bills on-demand queries by
bytes processed, so a cap is the direct way to bound the cost of one query.
The remaining fields are for tracking rather than safety: `applicationName`
and `jobLabels` tag the BigQuery jobs your agent creates, and
`computeProjectId` and `location` pin where the work runs.

Build the config with `createBigQueryToolConfig`. The factory validates its
input and applies the defaults, so a config you hold is a config that already
passed every check. adk-python validates the same fields on its pydantic
model; this port moves that validation into the factory, because a plain
TypeScript interface has no constructor to hook.

## Get started

```ts
import {WriteMode, createBigQueryToolConfig} from '@google/adk';

// Read-only, 50 rows: the defaults.
const readOnly = createBigQueryToolConfig();

// Session-scoped writes, a cost ceiling, and tracking labels.
const guarded = createBigQueryToolConfig({
  writeMode: WriteMode.PROTECTED,
  maximumBytesBilled: 10_485_760,
  maxQueryResultRows: 100,
  applicationName: 'my-agent',
  computeProjectId: 'my-compute-project',
  location: 'us-central1',
  jobLabels: {environment: 'prod', team: 'data'},
});
```

## Fields and defaults

`writeMode` defaults to `WriteMode.BLOCKED` and `maxQueryResultRows` to `50`.
Both are required on the resolved type, because the factory always sets them.
`maximumBytesBilled`, `applicationName`, `computeProjectId`, `location` and
`jobLabels` are optional and stay `undefined` until you pass them. Each field
carries its own documentation on the `BigQueryToolConfig` type.

`applicationName` and `jobLabels` are for usage discovery and tracking. Do not
use them for security-sensitive decisions.

## Validation

`createBigQueryToolConfig` throws `InputValidationError` and never returns a
half-valid config. It rejects an unknown key, which is how adk-python's
`extra='forbid'` behaves, and it rejects a field of the wrong type. The field
names are camelCase here, so the adk-python spellings `write_mode` and
`job_labels` are unknown keys.

Three fields carry a rule of their own. `maximumBytesBilled` must be at least
the 10 MB BigQuery on-demand minimum. `applicationName` must not contain a
space. `jobLabels` is limited to 20 entries, and a key may not be empty or
start with the reserved `adk-bigquery-` prefix.

```ts
import {InputValidationError, createBigQueryToolConfig} from '@google/adk';

try {
  createBigQueryToolConfig({maximumBytesBilled: 10_485_759});
} catch (error) {
  if (error instanceof InputValidationError) {
    // "... So maximumBytesBilled must be set >=10485760."
  }
}
```

Two edge cases follow adk-python rather than the prose above. A
`maximumBytesBilled` of `0` is accepted, and an empty `applicationName` is
accepted: the reference guards both checks on a truthy value, and this port
keeps that behaviour so the two SDKs agree.

The `adk-bigquery-` prefix is reserved only at the start of a key. A key such
as `team-adk-bigquery-owner` is allowed.
