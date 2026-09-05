# BigQuery tool config

Declares what the BigQuery tools may write, how much a query may cost, where it
runs, and the labels its jobs will carry.

## Introduction

`BigQueryToolConfig` is the configuration surface for the BigQuery tools. It
holds data only. It opens no connection, reads no credentials and starts no
network call.

Nothing in adk-js reads the config yet. It is the first piece of the BigQuery
integration, and the tools that will take it as a parameter arrive in later
changes. So do not go looking for a `BigQueryToolset` export: the part that
works today is the type, its defaults and its validation.

You build the config with `createBigQueryToolConfig` rather than an object
literal. The factory validates its input, applies the defaults and returns a
fresh object, so a later change to the object you passed in cannot reach a
config you already built.

The most important field is `writeMode`. It defaults to `WriteMode.BLOCKED`, so
a config you build without thinking about it will permit only read queries.

## Get started

```ts
import {WriteMode, createBigQueryToolConfig} from '@google/adk';

// Read-only by default.
const readOnly = createBigQueryToolConfig();
readOnly.writeMode; // WriteMode.BLOCKED
readOnly.maxQueryResultRows; // 50

// Allow writes inside a BigQuery session, cap the spend, and label the jobs.
const sessionScoped = createBigQueryToolConfig({
  writeMode: WriteMode.PROTECTED,
  maximumBytesBilled: 10_485_760,
  computeProjectId: 'my-compute-project',
  location: 'us-central1',
  applicationName: 'my-agent',
  jobLabels: {environment: 'test', team: 'data'},
});
```

## Write mode

`WriteMode` has three members, and the config defaults to `BLOCKED`. The
meanings below are what the tools will enforce once they land.

| Member                | Meaning                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WriteMode.BLOCKED`   | No write operations. Only a `SELECT` query runs.                                                                                                                                                                                             |
| `WriteMode.PROTECTED` | Writes in the anonymous dataset of a BigQuery session. A temporary table can be created, changed and deleted there, while a permanent table stays protected. See [BigQuery sessions](https://cloud.google.com/bigquery/docs/sessions-intro). |
| `WriteMode.ALLOWED`   | All write operations.                                                                                                                                                                                                                        |

## Cost and result size

`maximumBytesBilled` will cap what one query may be billed for. BigQuery
on-demand pricing rounds a charge up to the nearest MB and bills at least 10 MB
per query, so a cap below `10485760` can never be met. The factory rejects one
today:

```ts
import {createBigQueryToolConfig} from '@google/adk';

createBigQueryToolConfig({maximumBytesBilled: 10_485_759});
// InputValidationError: In BigQuery on-demand pricing, charges are rounded up
// to the nearest MB, ... So maximumBytesBilled must be set >=10485760.
```

`maxQueryResultRows` will cap how many rows a query returns. It defaults to
`50`.

## Project and location

`computeProjectId` names the project that will run the compute, such as a query.
Set it when the tools must not bill work to the project your credentials resolve
to.

`location` names the BigQuery location of the data and the compute. When you
leave it out, BigQuery derives the location from the data the query references.
For the supported values, see
[BigQuery locations](https://cloud.google.com/bigquery/docs/locations).

## Application name and job labels

`applicationName` names the application that uses the tools. The tools will add
it to the user agent of a BigQuery API call, and to the job label
`adk-bigquery-application-name`. It must not contain a space.

`jobLabels` are the labels the tools will apply to every BigQuery job they run.
Use them for billing, monitoring and resource organization. For the label rules,
see [Introduction to labels](https://cloud.google.com/bigquery/docs/labels-intro).

Both fields serve usage discovery and tracking only. Never base a
security-sensitive decision on either one.

## Validation rules

Every rejection throws an `InputValidationError`.

| Input                                         | Message                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| An unknown key, or a field of the wrong type  | `Invalid BigQueryToolConfig: ...`                                                                  |
| `maximumBytesBilled` below `10485760`         | `In BigQuery on-demand pricing, ... So maximumBytesBilled must be set >=10485760.`                 |
| An `applicationName` containing a space       | `Application name should not contain spaces.`                                                      |
| More than 20 job labels                       | `Only up to 20 job labels can be provided`                                                         |
| A job label with an empty key                 | `Label keys cannot be empty.`                                                                      |
| A job label key starting with `adk-bigquery-` | `Label key cannot start with "adk-bigquery-" as it is reserved for internal usage, found "<key>".` |

The count check runs before the per-key checks, so a 21-label object reports the
count even when one of its keys is also invalid.

Two rules are looser than they look. A `maximumBytesBilled` of `0` is accepted,
which matches adk-python. And only a leading `adk-bigquery-` is reserved, so a
key such as `team-adk-bigquery-owner` is fine.

## Field spelling differs from adk-python

The factory rejects any key it does not know. This mirrors the `extra='forbid'`
setting on the adk-python model, and it catches a typo in a config that arrives
from JSON or YAML at the point it enters your code.

The two SDKs disagree on the spelling, and the disagreement is deliberate.
adk-python accepts `write_mode`, because that is the Python convention. adk-js
accepts `writeMode` and rejects `write_mode`:

```ts
import {createBigQueryToolConfig} from '@google/adk';

createBigQueryToolConfig(JSON.parse('{"write_mode": "allowed"}'));
// InputValidationError: Invalid BigQueryToolConfig: ✖ Unrecognized key: "write_mode"
```

The three `WriteMode` values do cross the boundary, so they match adk-python
exactly: `'blocked'`, `'protected'` and `'allowed'`.
