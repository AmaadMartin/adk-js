/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AnalyticsEventType,
  AnalyticsPayloadColumn,
} from './bigquery_analytics_schema.js';

/**
 * One flattened view per event type, over the events table.
 *
 * The events table keeps its payload in three JSON columns, which is what lets
 * one table hold every event type. A query then has to know the JSON path for
 * the type it is reading. These views do that once: each selects the rows of a
 * single `event_type` and lifts that type's fields out of the JSON into typed
 * columns.
 *
 * The column expressions match
 * `google/adk-python`'s `_EVENT_VIEW_DEFS` and `_VIEW_SQL_TEMPLATE`, so a query
 * written against a Python-created view works against a JavaScript-created one.
 */

/** Columns every view selects. All are protected from projection. */
export const VIEW_COMMON_COLUMNS: readonly string[] = [
  'timestamp',
  'event_id',
  'event_type',
  'agent',
  'session_id',
  'invocation_id',
  'user_id',
  'trace_id',
  'span_id',
  'parent_span_id',
  'status',
  'error_message',
  'is_truncated',
];

/**
 * The derived columns each event type's view adds after the common ones, as
 * `<SQL expression> AS <alias>`.
 */
export const EVENT_VIEW_DEFS: ReadonlyMap<
  AnalyticsEventType,
  readonly string[]
> = new Map([
  [AnalyticsEventType.USER_MESSAGE_RECEIVED, []],
  [
    AnalyticsEventType.LLM_REQUEST,
    [
      "JSON_VALUE(attributes, '$.model') AS model",
      'content AS request_content',
      "JSON_QUERY(attributes, '$.llm_config') AS llm_config",
      "JSON_QUERY(attributes, '$.tools') AS tools",
    ],
  ],
  [
    AnalyticsEventType.LLM_RESPONSE,
    [
      "JSON_QUERY(content, '$.response') AS response",
      "CAST(JSON_VALUE(content, '$.usage.prompt') AS INT64) AS usage_prompt_tokens",
      "CAST(JSON_VALUE(content, '$.usage.completion') AS INT64) AS usage_completion_tokens",
      "CAST(JSON_VALUE(content, '$.usage.total') AS INT64) AS usage_total_tokens",
      "CAST(JSON_VALUE(attributes, '$.usage_metadata.cached_content_token_count') AS INT64) AS usage_cached_tokens",
      "CAST(JSON_VALUE(attributes, '$.usage_metadata.thoughts_token_count') AS INT64) AS usage_thinking_tokens",
      "CAST(JSON_VALUE(attributes, '$.usage_metadata.tool_use_prompt_token_count') AS INT64) AS usage_tool_use_tokens",
      "SAFE_DIVIDE(CAST(JSON_VALUE(attributes, '$.usage_metadata.cached_content_token_count') AS INT64),CAST(JSON_VALUE(content, '$.usage.prompt') AS INT64)) AS context_cache_hit_rate",
      "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
      "CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS INT64) AS ttft_ms",
      "JSON_VALUE(attributes, '$.model_version') AS model_version",
      "JSON_QUERY(attributes, '$.usage_metadata') AS usage_metadata",
      "JSON_QUERY(attributes, '$.cache_metadata') AS cache_metadata",
      "JSON_VALUE(attributes, '$.cache_type') AS cache_type",
      "JSON_VALUE(attributes, '$.finish_reason') AS finish_reason",
    ],
  ],
  [
    AnalyticsEventType.LLM_ERROR,
    ["CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms"],
  ],
  [
    AnalyticsEventType.TOOL_STARTING,
    [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
      "JSON_VALUE(content, '$.tool_origin') AS tool_origin",
    ],
  ],
  [
    AnalyticsEventType.TOOL_COMPLETED,
    [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.result') AS tool_result",
      "JSON_VALUE(content, '$.tool_origin') AS tool_origin",
      "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
      "JSON_VALUE(attributes, '$.adk.pause_kind') AS pause_kind",
      "JSON_VALUE(attributes, '$.adk.function_call_id') AS function_call_id",
    ],
  ],
  [
    AnalyticsEventType.TOOL_ERROR,
    [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
      "JSON_VALUE(content, '$.tool_origin') AS tool_origin",
      "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
    ],
  ],
  [
    AnalyticsEventType.AGENT_STARTING,
    ["JSON_VALUE(content, '$.text_summary') AS agent_instruction"],
  ],
  [
    AnalyticsEventType.AGENT_COMPLETED,
    ["CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms"],
  ],
  [
    AnalyticsEventType.AGENT_ERROR,
    [
      "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
      "JSON_VALUE(content, '$.error_traceback') AS error_traceback",
    ],
  ],
  [AnalyticsEventType.INVOCATION_STARTING, []],
  [AnalyticsEventType.INVOCATION_COMPLETED, []],
  [
    AnalyticsEventType.INVOCATION_ERROR,
    ["JSON_VALUE(content, '$.error_traceback') AS error_traceback"],
  ],
  [
    AnalyticsEventType.STATE_DELTA,
    ["JSON_QUERY(attributes, '$.state_delta') AS state_delta"],
  ],
  [
    AnalyticsEventType.HITL_CREDENTIAL_REQUEST,
    [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
    ],
  ],
  [
    AnalyticsEventType.HITL_CONFIRMATION_REQUEST,
    [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
    ],
  ],
  [
    AnalyticsEventType.HITL_INPUT_REQUEST,
    [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
    ],
  ],
  [
    AnalyticsEventType.A2A_INTERACTION,
    [
      'content AS response_content',
      'JSON_VALUE(attributes, \'$.a2a_metadata."a2a:task_id"\') AS a2a_task_id',
      'JSON_VALUE(attributes, \'$.a2a_metadata."a2a:context_id"\') AS a2a_context_id',
      'JSON_QUERY(attributes, \'$.a2a_metadata."a2a:request"\') AS a2a_request',
      'JSON_QUERY(attributes, \'$.a2a_metadata."a2a:response"\') AS a2a_response',
    ],
  ],
  [
    AnalyticsEventType.AGENT_RESPONSE,
    [
      "JSON_VALUE(content, '$.response') AS response_text",
      "JSON_VALUE(attributes, '$.source_event_id') AS source_event_id",
      "JSON_VALUE(attributes, '$.source_event_author') AS source_event_author",
      "JSON_VALUE(attributes, '$.source_event_branch') AS source_event_branch",
    ],
  ],
  [
    AnalyticsEventType.AGENT_TRANSFER,
    [
      "JSON_VALUE(content, '$.from_agent') AS from_agent",
      "JSON_VALUE(content, '$.to_agent') AS to_agent",
      "JSON_VALUE(attributes, '$.adk.source_event_id') AS source_event_id",
    ],
  ],
  [
    AnalyticsEventType.EVENT_COMPACTION,
    [
      "CAST(JSON_VALUE(content, '$.start_timestamp') AS FLOAT64) AS start_seconds",
      "CAST(JSON_VALUE(content, '$.end_timestamp') AS FLOAT64) AS end_seconds",
      "TIMESTAMP_MICROS(CAST(CAST(JSON_VALUE(content, '$.start_timestamp') AS FLOAT64) * 1000000 AS INT64)) AS window_start",
      "TIMESTAMP_MICROS(CAST(CAST(JSON_VALUE(content, '$.end_timestamp') AS FLOAT64) * 1000000 AS INT64)) AS window_end",
      "JSON_QUERY(content, '$.compacted_content') AS compacted_content",
    ],
  ],
  [
    AnalyticsEventType.AGENT_STATE_CHECKPOINT,
    [
      "JSON_QUERY(content, '$.agent_state') AS agent_state",
      "JSON_TYPE(JSON_QUERY(content, '$.agent_state')) AS agent_state_type",
      "SAFE_CAST(JSON_VALUE(content, '$.end_of_agent') AS BOOL) AS end_of_agent",
      "JSON_VALUE(attributes, '$.adk.source_event_id') AS source_event_id",
    ],
  ],
  [
    AnalyticsEventType.TOOL_PAUSED,
    [
      "JSON_VALUE(content, '$.tool') AS tool_name",
      "JSON_QUERY(content, '$.args') AS tool_args",
      "JSON_VALUE(attributes, '$.adk.pause_kind') AS pause_kind",
      "JSON_VALUE(attributes, '$.adk.function_call_id') AS function_call_id",
    ],
  ],
  [
    AnalyticsEventType.NODE_OUTPUT,
    [
      "JSON_VALUE(attributes, '$.adk.node.path') AS node_path",
      "JSON_VALUE(attributes, '$.adk.node.run_id') AS node_run_id",
      "JSON_VALUE(attributes, '$.adk.node.parent_run_id') AS node_parent_run_id",
      'content AS output',
    ],
  ],
  [
    AnalyticsEventType.NODE_ERROR,
    [
      "JSON_VALUE(attributes, '$.adk.node.path') AS node_path",
      "JSON_VALUE(attributes, '$.adk.node.run_id') AS node_run_id",
      "JSON_VALUE(attributes, '$.adk.node.parent_run_id') AS node_parent_run_id",
      "JSON_VALUE(content, '$.error_code') AS error_code",
    ],
  ],
]);

/** The table a view of `eventType` is named after. */
export function analyticsViewName(
  viewPrefix: string,
  eventType: AnalyticsEventType,
): string {
  return `${viewPrefix}_${eventType.toLowerCase()}`;
}

/**
 * Drops the derived columns that read a column the caller projected out.
 *
 * A view naming a column the table does not have fails to create, so the
 * dependent columns go rather than the view. The common columns are all
 * protected, so a view always keeps its identity and correlation columns.
 *
 * @param columns The event type's derived column expressions.
 * @param denied The columns projected out of the table.
 * @return The expressions that still read only columns the table has.
 */
export function projectViewColumns(
  columns: readonly string[],
  denied: ReadonlySet<AnalyticsPayloadColumn>,
): string[] {
  if (denied.size === 0) {
    return [...columns];
  }
  const patterns = [...denied].map((column) => new RegExp(`\\b${column}\\b`));
  return columns.filter(
    (expression) => !patterns.some((pattern) => pattern.test(expression)),
  );
}

/** Everything one `CREATE OR REPLACE VIEW` statement needs. */
export interface AnalyticsViewOptions {
  projectId: string;
  datasetId: string;
  tableId: string;
  viewPrefix: string;
  denied: ReadonlySet<AnalyticsPayloadColumn>;
}

/** One view to create, and the statement that creates it. */
export interface AnalyticsViewStatement {
  viewName: string;
  sql: string;
}

/**
 * Builds the `CREATE OR REPLACE VIEW` statement for one event type.
 *
 * Every value interpolated here is either a fixed literal of this module or a
 * caller-supplied identifier, never row content, so the statement carries no
 * data a model or a tool produced.
 */
function buildViewSql(
  options: AnalyticsViewOptions,
  eventType: AnalyticsEventType,
  columns: readonly string[],
): AnalyticsViewStatement {
  const {projectId, datasetId, tableId, viewPrefix} = options;
  const viewName = analyticsViewName(viewPrefix, eventType);
  const selected = [...VIEW_COMMON_COLUMNS, ...columns].join(',\n  ');
  return {
    viewName,
    sql:
      `CREATE OR REPLACE VIEW \`${projectId}.${datasetId}.${viewName}\` AS\n` +
      `SELECT\n  ${selected}\nFROM\n` +
      `  \`${projectId}.${datasetId}.${tableId}\`\nWHERE\n` +
      `  event_type = '${eventType}'\n`,
  };
}

/**
 * The statement for every event type's view, with the projected-out columns
 * already removed.
 *
 * @param options The table the views read and the prefix they are named with.
 * @return One statement per entry of {@link EVENT_VIEW_DEFS}.
 */
export function analyticsViewStatements(
  options: AnalyticsViewOptions,
): AnalyticsViewStatement[] {
  return [...EVENT_VIEW_DEFS].map(([eventType, columns]) =>
    buildViewSql(
      options,
      eventType,
      projectViewColumns(columns, options.denied),
    ),
  );
}
