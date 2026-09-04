/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SqliteSpanExporter
 * ../../../docs/guides/telemetry/sqlite_span_exporter/index.md
 *
 * Persists this agent's OpenTelemetry spans to `adk_traces.db` in the working
 * directory, so the trace tree of a session survives a restart. Only the
 * `call_llm` span carries the session id, so the agent has to call a model for
 * the file to hold anything queryable.
 *
 * REQUIRES the optional SQLite driver and an API key. Set GEMINI_API_KEY, then:
 *   npm install @mikro-orm/sqlite
 *   npm run sample -- samples/telemetry/sqlite_span_exporter/agent.ts
 *
 * Send a turn, stop the process, and read the rows back:
 *   sqlite3 adk_traces.db 'select session_id, name from spans'
 */

import {LlmAgent, maybeSetOtelProviders, SqliteSpanExporter} from '@google/adk';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';

const exporter = new SqliteSpanExporter({dbPath: './adk_traces.db'});

// `SimpleSpanProcessor` exports each span as it ends, which is what makes the
// rows readable while the process is still running. A `BatchSpanProcessor`
// works too and writes fewer times.
maybeSetOtelProviders([{spanProcessors: [new SimpleSpanProcessor(exporter)]}]);

export const rootAgent = new LlmAgent({
  name: 'traced_agent',
  model: 'gemini-flash-latest',
  instruction: 'Answer the user in one short sentence.',
});
