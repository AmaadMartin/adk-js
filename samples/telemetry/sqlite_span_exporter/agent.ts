/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SqliteSpanExporter
 * ../../../docs/guides/telemetry/sqlite_span_exporter/index.md
 *
 * Persists this workflow's OpenTelemetry spans to `adk_traces.db` in the
 * working directory, so the trace tree of a session survives a restart. The
 * workflow invocation span carries `gen_ai.conversation.id`, which is what
 * `getAllSpansForSession` resolves the session by; the node spans have no
 * session attribute and come back because they share the trace.
 *
 * Run (offline, no API key). The SQLite driver is an optional peer:
 *   npm install @mikro-orm/sqlite
 *   npm run sample -- samples/telemetry/sqlite_span_exporter/agent.ts
 *
 * Send a turn, then type `exit`. The rows are already on disk:
 *   sqlite3 adk_traces.db 'select session_id, name from spans'
 */

import {
  maybeSetOtelProviders,
  node,
  NodeContext,
  SqliteSpanExporter,
  Workflow,
} from '@google/adk';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';

const exporter = new SqliteSpanExporter({dbPath: './adk_traces.db'});

// `SimpleSpanProcessor` exports each span as it ends, which is what makes the
// rows readable while the process is still running. A `BatchSpanProcessor`
// works too and writes fewer times.
maybeSetOtelProviders([{spanProcessors: [new SimpleSpanProcessor(exporter)]}]);

const shoutNode = node(
  (_ctx: NodeContext, nodeInput: string) => nodeInput.trim().toUpperCase(),
  {name: 'shout_node'},
);

export const rootAgent = new Workflow({
  name: 'traced_workflow',
  edges: [['START', shoutNode]],
});
