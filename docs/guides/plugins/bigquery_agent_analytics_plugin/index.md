# BigQueryAgentAnalyticsPlugin

`BigQueryAgentAnalyticsPlugin` writes one BigQuery row for every step an agent takes: the user message, the invocation, each agent turn, each model request and response, each tool call, and each state change. Reach for it when you need to answer questions about agent behaviour in SQL — which tool fails most, what a turn costs in tokens, how long the model took — rather than by reading logs.

## Introduction

An agent run produces a stream of callbacks and nothing durable. Logs answer "what happened in this run"; they do not answer "what happened across ten thousand runs". This plugin turns the callback stream into rows of a partitioned, clustered table, so the second question becomes a query.

It is a `BasePlugin` subclass, so it observes the whole runner lifecycle without any change to your agents. It sits alongside OpenTelemetry rather than replacing it: tracing tells you where one slow request spent its time, and this table tells you how a population of requests behaves. The two join on `trace_id`, which the plugin inherits from the ambient OpenTelemetry span when one is active.

The table schema is the same one `google/adk-python`'s plugin of the same name writes — same column names, same types, same `adk_schema_version` label. One dataset can therefore hold rows from a TypeScript agent and a Python agent, and a query written against either works against both.

Three properties are worth knowing before you enable it:

- **It never breaks a run.** Every callback catches its own failures and logs them. A BigQuery outage costs you rows, not requests.
- **It redacts credentials.** Any property whose name is a known credential name — `apiKey`, `access_token`, `Authorization`, anything under `temp:` — is replaced with `[REDACTED]` before the row is written.
- **It is bounded.** The row queue, the string lengths, the sanitizer's depth and the per-invocation span bookkeeping all have caps, so a runaway payload cannot grow the process without limit.

## Get started

`@google-cloud/bigquery` is an optional peer dependency. Install it, and create the dataset first — the plugin creates the table, never the dataset.

```bash
npm install @google-cloud/bigquery
bq mk --dataset "${GOOGLE_CLOUD_PROJECT}:agent_analytics"
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

The 17 columns are:

| Column                                   | Type            | What it holds                                                    |
| :--------------------------------------- | :-------------- | :--------------------------------------------------------------- |
| `timestamp`                              | TIMESTAMP       | When the event happened, UTC. The partitioning column.           |
| `event_id`                               | STRING          | A 32-hex id, also used as the insert id for de-duplication.      |
| `event_type`                             | STRING          | One of the values below.                                         |
| `agent`                                  | STRING          | The running agent's name, or the emitting event's author.        |
| `session_id`, `invocation_id`, `user_id` | STRING          | Identity columns.                                                |
| `trace_id`, `span_id`, `parent_span_id`  | STRING          | The execution tree.                                              |
| `content`                                | JSON            | The event payload, sanitized.                                    |
| `content_parts`                          | RECORD REPEATED | One record per part of a multi-modal payload.                    |
| `attributes`                             | JSON            | Enrichment: model, usage, session metadata, custom tags.         |
| `latency_ms`                             | JSON            | `total_ms`, and `time_to_first_token_ms` on a streamed response. |
| `status`                                 | STRING          | `OK` or `ERROR`.                                                 |
| `error_message`                          | STRING          | The failure, sanitized. Also set on some `OK` responses.         |
| `is_truncated`                           | BOOLEAN         | Whether any payload was cut. Redaction does not set it.          |

The `event_type` values are `USER_MESSAGE_RECEIVED`, `INVOCATION_STARTING`, `INVOCATION_COMPLETED`, `AGENT_STARTING`, `AGENT_COMPLETED`, `AGENT_RESPONSE`, `LLM_REQUEST`, `LLM_RESPONSE`, `LLM_ERROR`, `TOOL_STARTING`, `TOOL_COMPLETED`, `TOOL_ERROR` and `STATE_DELTA`.

`content_parts.object_ref` and `storage_mode: GCS_REFERENCE` are declared so the table matches a Python-written one, but nothing populates them: this plugin does not offload large content to Cloud Storage.

## The execution tree

Rows are not flat. `span_id` and `parent_span_id` reconstruct the shape of a turn, and every row of one invocation shares a `trace_id`.

- An `LLM_REQUEST` row and its `LLM_RESPONSE` row share one `span_id`. A streamed response keeps that span open across every partial chunk and closes it on the final one, so all the chunks share it too.
- A `TOOL_STARTING` row and its `TOOL_COMPLETED` or `TOOL_ERROR` row share one `span_id`.
- `INVOCATION_COMPLETED` reuses the invocation's root `span_id` and carries the whole turn's `latency_ms.total_ms`.

Span state is keyed by invocation id, so two invocations running at once never mix. The plugin tracks at most 1024 invocations and evicts the oldest first, which bounds the memory an invocation whose `afterRunCallback` never fires can hold.

## Configuration

Everything below is optional.

| Option                 | Type                              | Default                              | What it does                                                             |
| :--------------------- | :-------------------------------- | :----------------------------------- | :----------------------------------------------------------------------- |
| `enabled`              | `boolean`                         | `true`                               | When false the plugin does nothing at all: no client, no table, no rows. |
| `eventAllowlist`       | `AnalyticsEventType[]`            | unset                                | When set, only these types are written.                                  |
| `eventDenylist`        | `AnalyticsEventType[]`            | unset                                | These types are never written. Applied before the allowlist.             |
| `maxContentLength`     | `number`                          | `512000`                             | Maximum length of any captured string, or `-1` for no limit.             |
| `clusteringFields`     | `string[]`                        | `['event_type', 'agent', 'user_id']` | Clustering columns of the created table.                                 |
| `logMultiModalContent` | `boolean`                         | `true`                               | Whether `content_parts` is populated.                                    |
| `batchSize`            | `number`                          | `1`                                  | Rows per insert. The default writes each row as it is produced.          |
| `batchFlushIntervalMs` | `number`                          | `1000`                               | How long a partial batch waits.                                          |
| `shutdownTimeoutMs`    | `number`                          | `10000`                              | How long `shutdown()` waits for the queue to drain.                      |
| `queueMaxSize`         | `number`                          | `10000`                              | Rows held in memory before new ones are dropped.                         |
| `contentFormatter`     | `(content, eventType) => unknown` | unset                                | Replaces the payload before it is written.                               |
| `logSessionMetadata`   | `boolean`                         | `true`                               | Whether `attributes.session_metadata` is written.                        |
| `customTags`           | `Record<string, unknown>`         | `{}`                                 | Static tags copied into `attributes.custom_tags`.                        |
| `flushOnRunEnd`        | `boolean`                         | `true`                               | Whether each run ends with a flush.                                      |

The two duration options carry an `Ms` suffix and take milliseconds. adk-python's equivalents take float seconds; the rename exists so that `batchFlushInterval: 1000` cannot silently mean sixteen minutes.

Redaction is not configurable. It is a fixed set of credential names, matched after folding case, `-`/`_` and camel humps together, plus every key beginning `temp:`.

## Failure modes

Nothing here throws at your agent. Every loss is counted, and `getDropStats()` returns the counters — they survive `shutdown()`, so you can export them after the run.

```typescript
const dropped = analytics.getDropStats();
// {queue_full: 0, write_failed: 0, shutdown_timeout: 0,
//  setup_unavailable: 0, formatter_failed: 0, content_parse_failed: 0}
```

| Reason                 | What happened                                                                                                             |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `setup_unavailable`    | The client or the table could not be opened. The row is lost and the next event retries the setup.                        |
| `queue_full`           | The queue was at `queueMaxSize`. The incoming row is dropped rather than blocking the agent.                              |
| `write_failed`         | BigQuery rejected the batch. The batch is dropped.                                                                        |
| `shutdown_timeout`     | Rows were still pending when `shutdownTimeoutMs` expired.                                                                 |
| `formatter_failed`     | `contentFormatter` threw. The row is still written, with `content` set to `[FORMATTER_FAILED]`.                           |
| `content_parse_failed` | The payload could not be read. The row is written with `content` set to `[CONTENT_PARSE_FAILED]` and `is_truncated` true. |

The last two mean the row landed with its payload replaced, not that the row was lost. Both log a fixed message that never includes the payload, the exception text or a type name, because all three can be attacker-supplied.

Writes use `table.insert()` with `insertId` set to the row's `event_id`, which gives best-effort de-duplication. There is no exactly-once delivery: `@google-cloud/bigquery` retries on its own, and the plugin adds no retry loop of its own on top.
