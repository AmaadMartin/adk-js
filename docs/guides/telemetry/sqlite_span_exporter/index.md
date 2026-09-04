# SqliteSpanExporter

`SqliteSpanExporter` writes finished OpenTelemetry spans into a local SQLite
file and reads them back grouped by ADK session. Reach for it during local
development, when you want yesterday's trace tree to still be there after the
process restarts.

## Introduction

ADK opens a span for every model call, every tool call and every agent
invocation, and tags them with the session they belong to. Those spans live in
whatever exporter you register. The in-process exporters that back `adk web`
keep them in memory, so a restart loses every trace you had.

`SqliteSpanExporter` solves that one problem. It is an OpenTelemetry
`SpanExporter`, so it plugs into the same span processor pipeline as any other
exporter, and it stores each span as a row in a `spans` table. Its second half
is the read side: `getAllSpansForSession()` returns the spans of a session, so
a local UI or a script can rebuild a trace tree from the file.

It is not a replacement for a collector. There is no batching beyond what the
span processor gives you, no sampling, and no retention policy. For anything
leaving your machine, use an OTLP exporter.

The table and column names match the adk-python exporter exactly, so a file
written by one SDK is readable by the other.

## Get started

The exporter is backed by the optional `@mikro-orm/sqlite` peer dependency.
Install it first:

```bash
npm install @mikro-orm/sqlite
```

Then register the exporter with a span processor:

```ts
import {maybeSetOtelProviders, SqliteSpanExporter} from '@google/adk';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';

const exporter = new SqliteSpanExporter({dbPath: './adk_traces.db'});
maybeSetOtelProviders([{spanProcessors: [new SimpleSpanProcessor(exporter)]}]);

// ... run an agent ...

const spans = await exporter.getAllSpansForSession('session-123');
const names = spans.map((span) => span.name);
```

A runnable version of this is in
[`samples/telemetry/sqlite_span_exporter/agent.ts`](../../../../samples/telemetry/sqlite_span_exporter/agent.ts).

`dbPath` is required. It takes a file path, which need not exist yet, or
`:memory:` for a database that disappears with the process. The parent
directory must exist.

## How a session is resolved

The exporter reads the session id off the span's own attributes, in this order:

1. `gcp.vertex.agent.session_id`
2. `gen_ai.conversation.id`

Only a string counts. An empty string, a number, or a missing attribute falls
through to the next candidate, and a span that matches neither is stored with a
null `session_id`.

## A lookup returns whole traces

`getAllSpansForSession()` does not return only the spans that carry the session
id. It first collects the distinct trace ids of those spans, then returns
**every** span on those traces, oldest first.

That matters because ADK does not tag every span. An invocation span opened
before the session is known, or a tool span created by an instrumentation
library, carries no session attribute of its own. Filtering on the attribute
alone would return a trace tree with holes in it.

## Lifecycle

The database opens lazily, on the first `export()` or
`getAllSpansForSession()`, and stays open until you call `shutdown()`.
`shutdown()` is safe to call twice, safe on an exporter that never opened the
database, and a later call reopens the file.

Re-exporting a span id replaces the row it wrote before, so a span processor
that retries a batch does not duplicate rows.

## What to be careful about

**The file grows without bound.** The `spans` table has no retention or
rotation policy, matching the adk-python exporter. An `adk web` session left
running for a long time keeps adding rows. Delete the file when you are done
with it.

**Span attributes are written verbatim.** ADK copies prompts and model replies
onto its spans unless you turn that off, so the database file inherits whatever
`ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` left on them. Treat the file as
containing conversation content, and do not attach it to a bug report without
reading it first.

**An export failure is reported, not thrown.** `export()` reports
`ExportResultCode.FAILED` and logs a warning naming the error type and the
SQLite driver code. It deliberately omits the driver's own message, because
that message inlines the statement together with its bound values — which are
the span attributes. `getAllSpansForSession()` rejects with the full error
instead: it is called by your code, which needs to see it.

Because of that redaction, a missing `@mikro-orm/sqlite` shows up on the export
path only as `Failed to export spans to SQLite: Error`. The read path reports
the actionable message, naming the package and the install command.
