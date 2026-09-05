/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  AnalyticsEventType,
  validatePayloadColumnDenylist,
} from '../../src/plugins/bigquery_analytics_schema.js';
import {
  analyticsViewName,
  analyticsViewStatements,
  EVENT_VIEW_DEFS,
  projectViewColumns,
  VIEW_COMMON_COLUMNS,
} from '../../src/plugins/bigquery_analytics_views.js';

const OPTIONS = {
  projectId: 'test-project',
  datasetId: 'agent_analytics',
  tableId: 'agent_events',
  viewPrefix: 'v',
  denied: validatePayloadColumnDenylist([]),
};

/** The derived columns of one event type, joined for a substring assertion. */
function columnsOf(eventType: AnalyticsEventType): string {
  return (EVENT_VIEW_DEFS.get(eventType) ?? []).join('\n');
}

/** The statement for one event type's view. */
function sqlFor(eventType: AnalyticsEventType, denied: string[] = []): string {
  const statements = analyticsViewStatements({
    ...OPTIONS,
    denied: validatePayloadColumnDenylist(denied),
  });
  const name = analyticsViewName('v', eventType);
  const found = statements.find((statement) => statement.viewName === name);
  if (found === undefined) {
    return expect.fail(`no view statement for ${eventType}`);
  }
  return found.sql;
}

describe('EVENT_VIEW_DEFS registration', () => {
  it.each([
    AnalyticsEventType.AGENT_TRANSFER,
    AnalyticsEventType.EVENT_COMPACTION,
    AnalyticsEventType.AGENT_STATE_CHECKPOINT,
    AnalyticsEventType.TOOL_PAUSED,
  ])('registers a view def for %s', (eventType) => {
    expect(EVENT_VIEW_DEFS.has(eventType)).toBe(true);
    expect(Array.isArray(EVENT_VIEW_DEFS.get(eventType))).toBe(true);
  });

  it('registers a view def for every event type a row can carry', () => {
    // The three HITL completions share their requests' shape and adk-python
    // registers no def for them either; every other member must have one.
    const completions = [
      AnalyticsEventType.HITL_CREDENTIAL_REQUEST_COMPLETED,
      AnalyticsEventType.HITL_CONFIRMATION_REQUEST_COMPLETED,
      AnalyticsEventType.HITL_INPUT_REQUEST_COMPLETED,
    ];
    const missing = Object.values(AnalyticsEventType).filter(
      (eventType) =>
        !EVENT_VIEW_DEFS.has(eventType) && !completions.includes(eventType),
    );
    expect(missing).toEqual([]);
  });

  it('extracts the pause pair keys on the TOOL_PAUSED view', () => {
    const columns = columnsOf(AnalyticsEventType.TOOL_PAUSED);
    expect(columns).toContain('$.adk.pause_kind');
    expect(columns).toContain('$.adk.function_call_id');
  });

  it('extracts the pause pair keys on the TOOL_COMPLETED view too', () => {
    const columns = columnsOf(AnalyticsEventType.TOOL_COMPLETED);
    expect(columns).toContain('$.adk.pause_kind');
    expect(columns).toContain('$.adk.function_call_id');
  });

  it('widens the compaction window with TIMESTAMP_MICROS, not SECONDS', () => {
    const columns = columnsOf(AnalyticsEventType.EVENT_COMPACTION);
    expect(columns).toContain('AS FLOAT64) AS start_seconds');
    expect(columns).toContain('TIMESTAMP_MICROS');
    expect(columns).not.toContain('TIMESTAMP_SECONDS');
  });

  it('discriminates a null agent state by its JSON type', () => {
    const columns = columnsOf(AnalyticsEventType.AGENT_STATE_CHECKPOINT);
    expect(columns).toContain('JSON_TYPE(JSON_QUERY(content,');
    expect(columns).toContain('AS agent_state_type');
  });

  it('exposes the token usage columns on the LLM_RESPONSE view', () => {
    const columns = columnsOf(AnalyticsEventType.LLM_RESPONSE);
    for (const alias of [
      'usage_prompt_tokens',
      'usage_completion_tokens',
      'usage_total_tokens',
      'usage_cached_tokens',
      'usage_thinking_tokens',
      'context_cache_hit_rate',
      'ttft_ms',
    ]) {
      expect(columns).toContain(alias);
    }
  });

  it('exposes a traceback column on both error views', () => {
    expect(columnsOf(AnalyticsEventType.AGENT_ERROR)).toContain(
      'error_traceback',
    );
    expect(columnsOf(AnalyticsEventType.INVOCATION_ERROR)).toContain(
      'error_traceback',
    );
  });
});

describe('analyticsViewName', () => {
  it('lowercases the event type behind the prefix', () => {
    expect(analyticsViewName('v', AnalyticsEventType.TOOL_COMPLETED)).toBe(
      'v_tool_completed',
    );
  });

  it('uses the caller prefix', () => {
    expect(analyticsViewName('agent', AnalyticsEventType.LLM_REQUEST)).toBe(
      'agent_llm_request',
    );
  });
});

describe('analyticsViewStatements', () => {
  it('emits one statement per registered event type', () => {
    expect(analyticsViewStatements(OPTIONS)).toHaveLength(EVENT_VIEW_DEFS.size);
  });

  it('filters each view to its own event type', () => {
    for (const [eventType] of EVENT_VIEW_DEFS) {
      const sql = sqlFor(eventType);
      expect(sql).toContain('CREATE OR REPLACE VIEW');
      expect(sql).toContain('WHERE');
      expect(sql).toContain(`event_type = '${eventType}'`);
      expect(sql).toContain('.v_');
    }
  });

  it('reads from the configured table in the configured dataset', () => {
    expect(sqlFor(AnalyticsEventType.LLM_REQUEST)).toContain(
      '`test-project.agent_analytics.agent_events`',
    );
  });

  it('selects every common column on every view', () => {
    for (const [eventType] of EVENT_VIEW_DEFS) {
      const sql = sqlFor(eventType);
      for (const column of VIEW_COMMON_COLUMNS) {
        expect(sql).toContain(column);
      }
    }
  });

  it('emits a view with only the common columns when a type has no extras', () => {
    const sql = sqlFor(AnalyticsEventType.INVOCATION_STARTING);
    expect(sql).toContain('is_truncated\nFROM');
  });
});

describe('projectViewColumns', () => {
  it('keeps every column when nothing is denied', () => {
    const columns = ["JSON_VALUE(content, '$.tool') AS tool_name"];
    expect(
      projectViewColumns(columns, validatePayloadColumnDenylist([])),
    ).toEqual(columns);
  });

  it('drops a derived column that reads a denied column', () => {
    expect(
      projectViewColumns(
        [
          "JSON_VALUE(content, '$.tool') AS tool_name",
          "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
        ],
        validatePayloadColumnDenylist(['latency_ms']),
      ),
    ).toEqual(["JSON_VALUE(content, '$.tool') AS tool_name"]);
  });

  it('does not mistake content_parts for content', () => {
    const columns = ['content_parts AS parts'];
    expect(
      projectViewColumns(columns, validatePayloadColumnDenylist(['content'])),
    ).toEqual(columns);
  });

  it('drops the columns of every denied column at once', () => {
    expect(
      projectViewColumns(
        [
          "JSON_VALUE(attributes, '$.model') AS model",
          'content AS request_content',
          "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms",
        ],
        validatePayloadColumnDenylist(['content', 'latency_ms']),
      ),
    ).toEqual(["JSON_VALUE(attributes, '$.model') AS model"]);
  });
});

describe('analyticsViewStatements with a projected table', () => {
  it('drops the derived columns that read a denied column', () => {
    const sql = sqlFor(AnalyticsEventType.LLM_REQUEST, ['content']);
    expect(sql).not.toContain('request_content');
    expect(sql).toContain('AS model');
  });

  it('keeps the common columns when a payload column is denied', () => {
    const sql = sqlFor(AnalyticsEventType.LLM_REQUEST, ['content']);
    for (const column of VIEW_COMMON_COLUMNS) {
      expect(sql).toContain(column);
    }
  });

  it('still emits a view for a type whose extras all read a denied column', () => {
    const sql = sqlFor(AnalyticsEventType.LLM_ERROR, ['latency_ms']);
    expect(sql).toContain('CREATE OR REPLACE VIEW');
    expect(sql).not.toContain('total_ms');
  });

  it('emits one statement per event type whatever is denied', () => {
    expect(
      analyticsViewStatements({
        ...OPTIONS,
        denied: validatePayloadColumnDenylist([
          'content',
          'content_parts',
          'attributes',
          'latency_ms',
        ]),
      }),
    ).toHaveLength(EVENT_VIEW_DEFS.size);
  });
});
