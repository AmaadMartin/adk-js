# BigQueryAgentAnalyticsPlugin

`BigQueryAgentAnalyticsPlugin` writes one BigQuery row for every step an agent takes: the user message, the invocation, each agent turn, each model request and response, each tool call, each pause, and each state change. Reach for it when you need to answer questions about agent behaviour in SQL — which tool fails most, what a turn costs in tokens, how long a person took to approve a pause — rather than by reading logs.

## Introduction

An agent run produces a stream of callbacks and nothing durable. Logs answer "what happened in this run"; they do not answer "what happened across ten thousand runs". This plugin turns the callback stream into rows of a partitioned, clustered table, so the second question becomes a query.

It is a `BasePlugin` subclass, so it observes the whole runner lifecycle without any change to your agents. It sits alongside OpenTelemetry rather than replacing it: tracing tells you where one slow request spent its time, and this table tells you how a population of requests behaves. The two join on `trace_id`, which the plugin inherits from the ambient OpenTelemetry span when one is active.

The table schema is the same one `google/adk-python`'s plugin of the same name writes — same column names, same types, same `adk_schema_version` label. One dataset can therefore hold rows from a TypeScript agent and a Python agent, and a query written against either works against both.

Three properties are worth knowing before you enable it:

- **It never breaks a run.** Every callback catches its own failures and logs them. A BigQuery outage costs you rows, not requests.
- **It redacts credentials.** A property named `apiKey`, `access_token`, `Authorization` or anything under `temp:` is replaced with `[REDACTED]`. Free text is redacted by pattern: an `Authorization` header, a bearer token, an API key in a URL query, and a `name=value` pair whose name is one of those names. A secret in a shape none of these match is written like any other text, so deny `LLM_REQUEST` when your prompts can carry one.
- **It is bounded.** The row queue, the string lengths, the sanitizer's depth and the per-invocation span bookkeeping all have caps, so a runaway payload cannot grow the process without limit.

## Get started

`@google-cloud/bigquery` is an optional peer dependency. Install it. The plugin creates the dataset and the table on first use, so your credentials need permission to create both.

```bash
npm install @google-cloud/bigquery
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

const analytics = new BigQueryAgentAnalyticsPlugin({
  projectId: process.env.GOOGLE_CLOUD_PROJECT!,
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

## The table

On first use the plugin looks the table up and, when it is absent, creates it with day partitioning on `timestamp`, clustering on the configured fields, and the label `adk_schema_version: 2`. If another process wins the race, the plugin re-reads the existing table instead of failing.

`EVENTS_TABLE_SCHEMA` in `core/src/plugins/bigquery_analytics_schema.ts` is the authority on the 17 columns, and each carries the `description` a BigQuery user sees. Four are worth calling out because their shape is not obvious:

- `content`, `attributes` and `latency_ms` are `JSON` columns supplied as JSON-encoded strings. Read them with `JSON_VALUE`.
- `content_parts` is a repeated record, one entry per part of a multi-modal payload. Its `object_ref` field and the `GCS_REFERENCE` storage mode are declared so the table matches a Python-written one, but nothing populates them: this plugin does not offload large content to Cloud Storage.
- `is_truncated` says a payload was cut. Redacting a credential does not set it.
- `error_message` is also set on some `LLM_RESPONSE` rows whose `status` is `OK`, because a model can decline without failing.

The `event_type` values are the members of `AnalyticsEventType`. They cover the invocation (`INVOCATION_STARTING`, `INVOCATION_COMPLETED`), the agent (`AGENT_STARTING`, `AGENT_COMPLETED`, `AGENT_TRANSFER`, `AGENT_RESPONSE`), the model (`LLM_REQUEST`, `LLM_RESPONSE`, `LLM_ERROR`), the tool (`TOOL_STARTING`, `TOOL_COMPLETED`, `TOOL_ERROR`, `TOOL_PAUSED`), the workflow node (`NODE_OUTPUT`, `NODE_ERROR`), the user message (`USER_MESSAGE_RECEIVED`), session state (`STATE_DELTA`, `AGENT_STATE_CHECKPOINT`), and the three human-in-the-loop requests with their `_COMPLETED` counterparts.

Two of those types do not appear yet. `AGENT_STARTING` and `AGENT_COMPLETED` need `beforeAgentCallback` and `afterAgentCallback`. adk-js declares both hooks on `BasePlugin`, but nothing fires them: `PluginManager.runBeforeAgentCallback` and `runAfterAgentCallback` have no caller, so no plugin receives them. Use `INVOCATION_STARTING` and `INVOCATION_COMPLETED` for turn boundaries until the framework calls the hooks.

Every tool row — `TOOL_STARTING`, `TOOL_COMPLETED`, `TOOL_ERROR` — carries `tool_origin` in its `content`, saying where the call runs: `LOCAL`, `MCP`, `SUB_AGENT`, `A2A`, `TRANSFER_AGENT`, `TRANSFER_A2A` or `UNKNOWN`. adk-python writes the same key with the same values.

```sql
SELECT JSON_VALUE(content, '$.tool_origin') AS origin,
       COUNTIF(status = 'ERROR') / COUNT(*) AS error_rate
FROM `my-project.agent_analytics.agent_events`
WHERE event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR')
GROUP BY origin;
```

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
- Each numeric option must be a whole number of rows or milliseconds, and the constructor throws on a fractional or out-of-range value rather than dropping every row later.

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

## Failure modes

Nothing here throws at your agent. Every loss is counted, and `getDropStats()` returns the counters — they survive `shutdown()`, so you can export them after the run.

```typescript
const dropped = analytics.getDropStats();
// {queue_full: 0, write_failed: 0, shutdown_timeout: 0,
//  setup_unavailable: 0, formatter_failed: 0, content_parse_failed: 0}
```

The reasons split in two. `setup_unavailable`, `queue_full`, `write_failed` and `shutdown_timeout` mean the row never landed; after the first of those the next event retries the setup. `formatter_failed` and `content_parse_failed` mean the row **did** land, with its payload replaced by `[FORMATTER_FAILED]` or `[CONTENT_PARSE_FAILED]`. Those two log a fixed message that never includes the payload, the exception text or a type name, because all three can be attacker-supplied.

Writes use `table.insert()`, which is `tabledata.insertAll`, with the insert id set to the row's `event_id`. That gives best-effort de-duplication, not the exactly-once delivery that adk-python gets from Storage Write API streams. `@google-cloud/bigquery` retries on its own, and the plugin adds no retry loop on top. BigQuery can also reject the first rows written to a table it created moments earlier, until that new table propagates; those rows count as `write_failed`.
