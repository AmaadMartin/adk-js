# BigQueryAgentAnalyticsPlugin

`BigQueryAgentAnalyticsPlugin` writes one BigQuery row for every step an agent takes: the user message, the invocation, each agent turn, each model request and response, each tool call, each pause, and each state change. Reach for it when you need to answer questions about agent behaviour in SQL — which tool fails most, what a turn costs in tokens, how long a person took to approve a pause — rather than by reading logs.

## Introduction

An agent run produces a stream of callbacks and nothing durable. Logs answer "what happened in this run"; they do not answer "what happened across ten thousand runs". This plugin turns the callback stream into rows of a partitioned, clustered table, so the second question becomes a query.

It is a `BasePlugin` subclass, so it observes the whole runner lifecycle without any change to your agents. It sits alongside OpenTelemetry rather than replacing it: tracing tells you where one slow request spent its time, and this table tells you how a population of requests behaves. The two join on `trace_id`, which the plugin inherits from the ambient OpenTelemetry span when one is active.

The table schema is the same one `google/adk-python`'s plugin of the same name writes — same column names, same types, same `adk_schema_version` label. One dataset can therefore hold rows from a TypeScript agent and a Python agent, and a query written against either works against both.

Three properties are worth knowing before you enable it:

- **It never breaks a run.** Every callback catches its own failures and logs them. A BigQuery outage costs you rows, not requests.
- **It redacts credentials.** A property named `apiKey`, `access_token`, `Authorization` or anything under `temp:` is replaced with `[REDACTED]`. Free text is redacted by pattern: an `Authorization` header, a bearer token, an API key in a URL query, and a `name=value` pair whose name is one of those names. A secret in a shape none of these match is written like any other text, so deny `LLM_REQUEST` when your prompts can carry one.
- **It fails closed on a payload it cannot read.** See [Payload the sanitizer refuses](#payload-the-sanitizer-refuses).
- **It is bounded.** The row queue, the string lengths, the sanitizer's depth and the per-invocation span bookkeeping all have caps, so a runaway payload cannot grow the process without limit.

## Get started

`@google-cloud/bigquery` and `@google-cloud/bigquery-storage` are optional peer dependencies. Install both: the first creates the dataset, the table and the views, and the second appends the rows. The plugin creates the dataset and the table on first use, so your credentials need permission to create both.

```bash
npm install @google-cloud/bigquery @google-cloud/bigquery-storage
```

Then register the plugin on the runner and shut it down when the process ends.

```typescript
import {
  BigQueryAgentAnalyticsPlugin,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';

const agent = new LlmAgent({
  name: 'weather_agent',
  model: 'gemini-2.0-flash',
  instruction: 'Answer weather questions.',
});

const projectId = process.env['GOOGLE_CLOUD_PROJECT'];
if (projectId === undefined) {
  throw new Error(
    'Set GOOGLE_CLOUD_PROJECT to the project holding the dataset.',
  );
}

const analytics = new BigQueryAgentAnalyticsPlugin({
  projectId,
  datasetId: 'agent_analytics',
});

const runner = new Runner({
  appName: 'weather_app',
  agent,
  sessionService: new InMemorySessionService(),
  plugins: [analytics],
});

// ... drive the runner ...

await analytics.shutdown();
```

`shutdown()` drains the queue, releases the flush timer and makes every later callback a no-op. It is safe to call twice.

Each run ends with a flush, which `shutdownTimeoutMs` bounds, so a BigQuery call that hangs delays the run by a known amount instead of holding it open. Nothing is dropped: the next flush waits for that insert again. Set `flushOnRunEnd` to false to take the write off the run entirely and leave it to the timer.

If you do neither — `flushOnRunEnd` off and no `shutdown()` — the plugin still drains on `beforeExit`, which Node emits when the event loop empties. That backstop cannot cover an explicit `process.exit()` or a fatal signal, because neither leaves time for an insert. Call `shutdown()` when you need the guarantee.

Query the result:

```sql
SELECT event_type,
       COUNT(*) AS rows_written,
       APPROX_QUANTILES(CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64), 100)[OFFSET(50)] AS p50_ms
FROM `my-project.agent_analytics.agent_events`
WHERE DATE(timestamp) = CURRENT_DATE()
GROUP BY event_type
ORDER BY rows_written DESC;
```

To try it against a real project by hand: create a project, set `GOOGLE_CLOUD_PROJECT`, grant your credentials `roles/bigquery.dataEditor` on it, run the agent above, then run

```sql
SELECT event_type, COUNT(*) FROM `my-project.agent_analytics.agent_events` GROUP BY 1;
```

## The table

On first use the plugin looks the table up and, when it is absent, creates it with day partitioning on `timestamp`, clustering on the configured fields, and the label `adk_schema_version: 2`. If another process wins the race, the plugin re-reads the existing table instead of failing.

When the table already exists, the plugin brings it up to the current schema version. The upgrade is additive only: it adds the columns and the record sub-fields this version writes and the table lacks, and it never drops, retypes or reorders anything. A column whose type or mode differs is an error, not a rewrite — the plugin counts the setup as unavailable and tries again later, so a table you fix by hand recovers without a restart. The `adk_schema_version` label gates the work, so a table that is already current costs one metadata read per process. Set `autoSchemaUpgrade` to false to skip the path entirely.

`EVENTS_TABLE_SCHEMA` in `core/src/plugins/bigquery_analytics_schema.ts` is the authority on the 17 columns, and each carries the `description` a BigQuery user sees. Four are worth calling out because their shape is not obvious:

- `content`, `attributes` and `latency_ms` are `JSON` columns supplied as JSON-encoded strings. Read them with `JSON_VALUE`.
- `content_parts` is a repeated record, one entry per part of a multi-modal payload. Its `storage_mode` says where the content is: `INLINE` in the row, `EXTERNAL_URI` at a URI the caller supplied, or `GCS_REFERENCE` in a Cloud Storage object the plugin wrote. Only a `GCS_REFERENCE` part fills `object_ref`. See [Offloading large content to Cloud Storage](#offloading-large-content-to-cloud-storage).
- `is_truncated` says a payload was cut. Redacting a credential does not set it.
- `error_message` is also set on some `LLM_RESPONSE` rows whose `status` is `OK`, because a model can decline without failing.

The `event_type` values are the members of `AnalyticsEventType`. They cover the invocation (`INVOCATION_STARTING`, `INVOCATION_COMPLETED`), the agent (`AGENT_STARTING`, `AGENT_COMPLETED`, `AGENT_TRANSFER`, `AGENT_RESPONSE`), the model (`LLM_REQUEST`, `LLM_RESPONSE`, `LLM_ERROR`), the tool (`TOOL_STARTING`, `TOOL_COMPLETED`, `TOOL_ERROR`, `TOOL_PAUSED`), the workflow node (`NODE_OUTPUT`, `NODE_ERROR`), the user message (`USER_MESSAGE_RECEIVED`), session state (`STATE_DELTA`, `AGENT_STATE_CHECKPOINT`), and the three human-in-the-loop requests with their `_COMPLETED` counterparts.

`AGENT_STARTING` and `AGENT_COMPLETED` come from `beforeAgentCallback` and `afterAgentCallback`. `BaseAgent` calls `PluginManager.runBeforeAgentCallback` and `runAfterAgentCallback` around each agent it runs, so every agent in an invocation writes one row of each type. Use those two for agent boundaries, and `INVOCATION_STARTING` and `INVOCATION_COMPLETED` for turn boundaries.

Every tool row — `TOOL_STARTING`, `TOOL_COMPLETED`, `TOOL_ERROR` — carries `tool_origin` in its `content`, saying where the call runs: `LOCAL`, `MCP`, `SUB_AGENT`, `A2A`, `TRANSFER_AGENT`, `TRANSFER_A2A` or `UNKNOWN`. adk-python writes the same key with the same values.

```sql
SELECT JSON_VALUE(content, '$.tool_origin') AS origin,
       COUNTIF(status = 'ERROR') / COUNT(*) AS error_rate
FROM `my-project.agent_analytics.agent_events`
WHERE event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR')
GROUP BY origin;
```

An `LLM_REQUEST` row lists what the model was allowed to call in `attributes.tools`, one entry per tool carrying `name`, `description` and the `parameters` schema. A tool that cannot describe itself contributes its name alone, so one failing tool never costs you the others. adk-python writes the same three keys, and prefers a declaration's `parametersJsonSchema` over its `parameters` in the same way.

A workflow node that succeeds produces `NODE_OUTPUT`. A node that throws produces `NODE_ERROR`, with `status` of `ERROR` and the failure in `error_message`. `AGENT_STATE_CHECKPOINT` carries a resumable workflow's saved state, and an agent that ends without saving state still writes one with `end_of_agent` true.

Four members are declared so the enum matches the Python one and a query written for a shared dataset compiles. This SDK writes none of them. adk-js `BasePlugin` has no `onAgentErrorCallback` and no `onRunErrorCallback`, so nothing reports `AGENT_ERROR` or `INVOCATION_ERROR`. adk-js `EventActions` has no `compaction` field, so nothing reports `EVENT_COMPACTION`. Agent-to-agent capture is out of scope, so nothing reports `A2A_INTERACTION`. A model failure still produces `LLM_ERROR`, a tool failure still produces `TOOL_ERROR`, and a node failure still produces `NODE_ERROR`.

## Pauses and human-in-the-loop turns

A run that waits on a person or on a long-running tool produces a pause row and, later, a completion row. Both carry `attributes.adk.function_call_id`, so joining on it measures the wait.

- A long-running tool call produces `TOOL_PAUSED` with `attributes.adk.pause_kind` of `tool`. The client answers with a function response in its next message, which produces `TOOL_COMPLETED`.
- The framework's own requests — `adk_request_credential`, `adk_request_confirmation`, `adk_request_input` — produce `HITL_CREDENTIAL_REQUEST`, `HITL_CONFIRMATION_REQUEST` and `HITL_INPUT_REQUEST`, with `pause_kind` of `hitl_credential`, `hitl_confirmation` or `hitl_input`. Each answer produces the matching `HITL_*_REQUEST_COMPLETED`, never a `TOOL_COMPLETED`.
- A framework request is long-running too, so it produces two rows, not one: the `HITL_*_REQUEST` above and a `TOOL_PAUSED` carrying the same `function_call_id`. Its `pause_kind` comes from the call name, so it is `hitl_credential`, `hitl_confirmation` or `hitl_input` rather than `tool`. That is what lets one query count every pause uniformly on `TOOL_PAUSED` and still tell a human approval apart from a slow tool.

```sql
SELECT JSON_VALUE(attributes, '$.adk.pause_kind') AS pause_kind,
       TIMESTAMP_DIFF(MAX(timestamp), MIN(timestamp), SECOND) AS waited_seconds
FROM `my-project.agent_analytics.agent_events`
WHERE event_type LIKE 'HITL%' OR event_type IN ('TOOL_PAUSED', 'TOOL_COMPLETED')
GROUP BY JSON_VALUE(attributes, '$.adk.function_call_id'), pause_kind;
```

An event can name a long-running id that none of its function calls carries. The plugin still writes the `TOOL_PAUSED` row, with `tool` and `args` null, so the completion has something to pair with, and logs a warning.

## The execution tree

Rows are not flat. `span_id` and `parent_span_id` reconstruct the shape of a turn, and every row of one invocation shares a `trace_id`.

- An `LLM_REQUEST` row and its `LLM_RESPONSE` row share one `span_id`. A streamed response keeps that span open across every partial chunk and closes it on the final one, so all the chunks share it too.
- A `TOOL_STARTING` row and its `TOOL_COMPLETED` or `TOOL_ERROR` row share one `span_id`.
- `INVOCATION_COMPLETED` reuses the invocation's root `span_id` and carries the whole turn's `latency_ms.total_ms`.

Span state is keyed by invocation id, so two invocations running at once never mix. The plugin tracks at most 1024 invocations and evicts the oldest first, which bounds the memory an invocation whose `afterRunCallback` never fires can hold.

## Configuration

`BigQueryLoggerConfig` documents every option and its default, and all of them are optional. Two things about it are not visible from the type:

- The duration options carry an `Ms` suffix and take milliseconds. adk-python's equivalents take float seconds; the rename exists so that `batchFlushIntervalMs: 1000` cannot silently mean sixteen minutes.
- Redaction is deliberately not configurable. It is a fixed set of credential names, matched after folding case, `-`/`_` and camel humps together, plus every key beginning `temp:`.
- `tableId` appears twice: on the constructor and on the config. The constructor's wins, matching adk-python. Set either one.
- `batchSize` and `queueMaxSize` count whole rows and must be integers of at least 1. The duration options take any finite number greater than zero, so a fractional millisecond is accepted, matching adk-python's float seconds. `NaN` and `Infinity` are rejected explicitly, because an ordered comparison alone lets `NaN` past every range check.
- The constructor throws on an out-of-range value rather than dropping every row later.

Set `enableOtelCorrelation` to capture the ambient OpenTelemetry span into `attributes.otel.span_id` and `attributes.otel.trace_id`, which joins a row to a Cloud Trace export. It is off by default, and the plugin opens no span of its own. An unsampled span is absent from the export, so treat the join as best effort.

Some agents answer through a dedicated tool instead of a plain text event. Name those tools in `finalResponseToolNames`, and completing one writes an `AGENT_RESPONSE` row carrying the call arguments, alongside the usual `TOOL_COMPLETED`.

```typescript
const analytics = new BigQueryAgentAnalyticsPlugin({
  projectId: 'my-project',
  datasetId: 'agent_analytics',
  config: {finalResponseToolNames: ['submit_answer']},
});
```

The default `batchSize` of 1 writes each row as it is produced, which is the simplest behaviour to reason about and the slowest. Raise it, and `batchFlushIntervalMs` bounds how long a partial batch waits.

### The views

The events table keeps its payload in three JSON columns, which is what lets one table hold every event type. A query then has to know the JSON path for the type it is reading. On first use the plugin creates one view per event type that does this once: each selects the rows of a single `event_type` and lifts that type's fields out of the JSON into typed columns.

A view is named `<viewPrefix>_<event_type in lower case>`, so `TOOL_COMPLETED` becomes `v_tool_completed`. Querying the tool failure rate above becomes:

```sql
SELECT tool_origin, COUNTIF(status = 'ERROR') / COUNT(*) AS error_rate
FROM `my-project.agent_analytics.v_tool_completed`
GROUP BY tool_origin;
```

The statements are `CREATE OR REPLACE VIEW`, so the pass is safe to repeat, and it runs once per process. A view that cannot be created is logged and skipped: the table already holds every row, so a reporting problem must not stop the writes. Set `createViews` to false to skip the pass, and `viewPrefix` to rename the views. An empty prefix throws at construction, because a view would then be named after the event type alone and could collide with an ordinary table in the dataset.

The column expressions match adk-python's, so a query written against a Python-created view works here unchanged. Projection applies: a derived column that reads a column you put in `payloadColumnDenylist` is left out of the view rather than failing its creation, and the identity and correlation columns are always kept.

### Credentials

The client uses Application Default Credentials. Pass `credentials` to authenticate as a particular service account instead.

```typescript
const clientEmail = process.env['ANALYTICS_CLIENT_EMAIL'];
const privateKey = process.env['ANALYTICS_PRIVATE_KEY'];
if (clientEmail === undefined || privateKey === undefined) {
  throw new Error('Set ANALYTICS_CLIENT_EMAIL and ANALYTICS_PRIVATE_KEY.');
}

const analytics = new BigQueryAgentAnalyticsPlugin({
  projectId: 'my-project',
  datasetId: 'agent_analytics',
  credentials: {client_email: clientEmail, private_key: privateKey},
});
```

### Capturing custom metadata

`customMetadataAllowlist` copies chosen `event.customMetadata` keys into `attributes.custom_metadata`. An entry ending in `*` matches by prefix; every other entry matches in full, so a plain key never behaves as a prefix. Nothing is captured by default.

```typescript
const analytics = new BigQueryAgentAnalyticsPlugin({
  projectId: 'my-project',
  datasetId: 'agent_analytics',
  config: {customMetadataAllowlist: ['a2a:*', 'tenant_id']},
});
```

A captured value takes the same safety pass as every other captured value: long strings are truncated, credential-bearing keys are replaced, and a reference back to an ancestor becomes `[CIRCULAR_REFERENCE]`. A truncated capture sets the row's `is_truncated`.

### Dropping payload columns

`payloadColumnDenylist` leaves a column out of the created table and out of every row, which is how you keep prompt and response bodies out of the dataset while still counting turns, latencies and failures.

```typescript
const analytics = new BigQueryAgentAnalyticsPlugin({
  projectId: 'my-project',
  datasetId: 'agent_analytics',
  config: {payloadColumnDenylist: ['content', 'content_parts']},
});
```

Only `content`, `content_parts`, `attributes` and `latency_ms` may be listed. Every other column is an identity or correlation column that the execution tree is reconstructed from, so naming one throws at construction rather than producing rows a query cannot correlate. The projection is applied to the schema first, so the table and the rows always carry the same columns. Dropping `attributes` while `customMetadataAllowlist` is set also throws, because the capture would be discarded.

### Offloading large content to Cloud Storage

An image or a long document does not belong in a BigQuery row. Set `gcsBucketName` and the plugin uploads such a part to Cloud Storage instead, then records where it went. `connectionId` names the BigQuery connection allowed to read those objects, written `location.connection_id`, and is copied onto every `object_ref`.

```typescript
const analytics = new BigQueryAgentAnalyticsPlugin({
  projectId: 'my-project',
  datasetId: 'agent_analytics',
  config: {
    gcsBucketName: 'my-agent-payloads',
    connectionId: 'us.my-bq-connection',
  },
});
```

The bucket needs `@google-cloud/storage`, which is an optional peer dependency: `npm install @google-cloud/storage`. The plugin does not create the bucket, unlike the dataset and the table. Create it yourself and grant the agent's identity `storage.objects.create` on it.

Two kinds of part are offloaded:

- **Inline bytes** — any `inlineData` part. The row records `text = '[MEDIA OFFLOADED]'` and the part's own MIME type. Without a bucket the same part records `text = '[BINARY DATA]'` and nothing is uploaded.
- **Text over either size limit** — text whose UTF-8 length exceeds 32 KiB, or whose character length exceeds `maxContentLength`. The two limits are counted in their own units, so a multi-byte payload is judged by bytes for storage and by characters for truncation. The row keeps the first 200 characters plus `... [OFFLOADED]`.

An offloaded part carries `storage_mode = 'GCS_REFERENCE'`, a `gs://` `uri`, and an `object_ref` holding that URI, the connection, and the content type as JSON.

```sql
SELECT part.uri, JSON_VALUE(part.object_ref.details, '$.gcs_metadata.content_type') AS content_type
FROM `my-project.agent_analytics.agent_events`, UNNEST(content_parts) AS part
WHERE part.storage_mode = 'GCS_REFERENCE';
```

Object names are `<YYYY-MM-DD>/<trace_id>/<span_id>_<uid>_c<message>_p<part><ext>`, where `<uid>` is unique to one parse. The date and the trace group a run's objects together; the rest makes the name unique, because a part index restarts at each message. The upload is create-only, so a name that already exists fails the upload rather than rebinding a written row to another event's bytes.

An offload failure never costs you the row. The plugin logs a warning and writes the row with `text = '[UPLOAD FAILED]'` for a binary part, or with the inline truncated text for a text part.

Two rules constrain when the offload runs. Text is sanitized before it is uploaded, so the object holds the same redacted value the row does. And listing `content_parts` in `payloadColumnDenylist` disables the offload entirely: that column holds the reference, so an upload would cost storage with nothing pointing at it.

### Redacting an external URI

A part carrying `fileData.fileUri` is stored as `EXTERNAL_URI`, and the URI is redacted first. A signed URL is a credential written as a link, so every surface that can carry one is inspected: a parameter or path segment named after a credential keeps its name and loses its value, and the fragment takes the same pass.

A URI that cannot be stored with any part intact becomes `[REDACTED_SENSITIVE_URI]`. That covers one carrying userinfo, one no URL parser accepts, one that is not a string, and one longer than 4,000,000 characters. It also covers a `data:`, `mailto:` or `blob:` URI whose path holds a credential: such a URL cannot be a base, so its path cannot be rewritten, and the whole URI is refused rather than stored with the credential still in it. Redaction sets the row's `is_truncated`.

### Payload the sanitizer refuses

Pattern redaction reads the characters in front of it. Two payload shapes defeat that, so the plugin writes a sentinel instead of the value and sets the row's `is_truncated`. adk-python does the same, under the same two sentinel names.

`[UNPARSEABLE_JSON_BLOB]` replaces a string that opens with `{` or `[` and that the sanitizer cannot walk. A JSON string escape spells a credential key without its characters ever appearing, so `{"access\u005ftoken":"..."} trailing` hides `access_token` from any scan of the raw text. The plugin therefore parses such a string or discards it. The four cases are a string that does not parse, one longer than 4,000,000 characters, one nested past 1,000 levels, and one whose trailing garbage breaks the parse.

The cost is real: an ordinary payload that merely opens with a bracket goes too. `[INFO] request finished` and `[urgent] find flights to SFO` both become the sentinel. A bracket inside a JSON string is payload rather than structure, so it does not count toward the nesting limit and a legitimate document survives. The `error_message` column takes the diagnostic pass instead, which keeps bracketed prose byte-identical.

`[REDACTED_SENSITIVE_TEXT]` replaces free text whose decoded form carries a credential. `access%5Ftoken=SECRET` holds no literal `access_token`, and decoding `%5F` exposes it. Decoding cannot be reversed character by character, so the plugin drops the whole string rather than guess where the credential sat. Text that decodes to nothing dangerous is untouched: a Windows path, a decoder error message, and encoded prose such as `progress%3D100%25 complete` all come back byte-identical.

## Failure modes

Nothing here throws at your agent. Every loss is counted, and `getDropStats()` returns the counters — they survive `shutdown()`, so you can export them after the run.

```typescript
const dropped = analytics.getDropStats();
// {queue_full: 0, retry_exhausted: 0, non_retryable: 0, unexpected_error: 0,
//  shutdown_timeout: 0, shutdown_race: 0, setup_unavailable: 0,
//  formatter_failed: 0, content_parse_failed: 0}
```

The reasons split in two. `formatter_failed` and `content_parse_failed` mean the row **did** land, with its payload replaced by `[FORMATTER_FAILED]` or `[CONTENT_PARSE_FAILED]`. Those two log a fixed message that never includes the payload, the exception text or a type name, because all three can be attacker-supplied. Every other reason means the row never landed:

| Reason              | What happened                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `queue_full`        | The row arrived at a queue already holding `queueMaxSize` rows.                               |
| `setup_unavailable` | The client or the table could not be opened. The next event retries the setup.                |
| `retry_exhausted`   | Every attempt the retry budget allowed failed.                                                |
| `non_retryable`     | BigQuery refused the rows for a reason another attempt cannot fix, such as a schema mismatch. |
| `unexpected_error`  | The append threw something carrying no status at all.                                         |
| `shutdown_timeout`  | The row was still pending when the shutdown timeout expired.                                  |
| `shutdown_race`     | A callback produced the row after `shutdown()` began.                                         |

Rows are appended through the BigQuery Storage Write API, to the table's default stream. That stream delivers at least once: an append the service accepted but did not acknowledge is retried, so a row can appear twice. De-duplicate on `event_id`, which is stable across retries of the same event. adk-python offers a committed-stream mode with explicit offsets for exactly-once delivery; that mode is not ported here, and it is off by default there too.

A table the plugin has just created answers an append with `NOT_FOUND` until it propagates. That status is retried for 60 seconds after the create and treated as a missing table after that, so the first rows of a new table are not lost and a genuinely wrong table id still fails fast.

### Retrying a failed write

`retryConfig` decides how often a failed append is attempted. The plugin turns the control-plane client's own automatic retry off, so a rate limit or a server error is retried on this schedule and no other. An append is retried on gRPC `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`, `INTERNAL` and `UNAVAILABLE`. Rows the service singles out are never retried: it named them, so re-sending them changes nothing.

```typescript
const analytics = new BigQueryAgentAnalyticsPlugin({
  projectId: 'my-project',
  datasetId: 'agent_analytics',
  config: {
    retryConfig: {
      maxRetries: 5, // retries after the first attempt, so 6 attempts in all
      initialDelayMs: 500,
      multiplier: 2,
      maxDelayMs: 10000,
    },
  },
});
```

The delay before retry `n` is `min(initialDelayMs * multiplier ** n, maxDelayMs)`. The delays are milliseconds, like every other duration here; adk-python's `RetryConfig` counts float seconds, so its `initial_delay: 1.0` is `initialDelayMs: 1000`. Setting `maxRetries: 0` turns retrying off.

Only a rate limit or a server-side condition is retried: HTTP 429, 500, 502 and 503, and the gRPC codes 4, 13 and 14. Anything else is counted and dropped without a wait. A partial failure is definitive — BigQuery accepted the rest of the batch and named the rows it rejected — so only those rows are charged, and they are not sent again.
