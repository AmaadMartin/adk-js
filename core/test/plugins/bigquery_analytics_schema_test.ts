/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {TableField} from '@google-cloud/bigquery';
import {describe, expect, it} from 'vitest';
import {
  AnalyticsEventType,
  AnalyticsRow,
  AnalyticsStatus,
  EVENTS_TABLE_SCHEMA,
  mergeSchemaFields,
  PROJECTABLE_PAYLOAD_COLUMNS,
  projectRow,
  projectSchema,
  validatePayloadColumnDenylist,
} from '../../src/plugins/bigquery_analytics_schema.js';

/** A row carrying every column, so a projection has something to remove. */
function makeRow(): AnalyticsRow {
  return {
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    event_id: 'e1',
    event_type: AnalyticsEventType.LLM_REQUEST,
    agent: 'agent',
    session_id: 's1',
    invocation_id: 'i1',
    user_id: 'u1',
    trace_id: 't1',
    span_id: 'sp1',
    parent_span_id: null,
    content: '{"a":1}',
    content_parts: [],
    attributes: '{}',
    latency_ms: '{"total_ms":5}',
    status: AnalyticsStatus.OK,
    error_message: null,
    is_truncated: false,
  };
}

/** The names of `fields`, in order. */
function names(fields: readonly TableField[]): Array<string | undefined> {
  return fields.map((field) => field.name);
}

describe('validatePayloadColumnDenylist', () => {
  it('returns an empty set when nothing is denied', () => {
    expect(validatePayloadColumnDenylist(undefined).size).toBe(0);
    expect(validatePayloadColumnDenylist([]).size).toBe(0);
  });

  it.each(PROJECTABLE_PAYLOAD_COLUMNS)('accepts %s', (column) => {
    expect(validatePayloadColumnDenylist([column]).has(column)).toBe(true);
  });

  it.each([
    'event_id',
    'timestamp',
    'event_type',
    'session_id',
    'invocation_id',
    'trace_id',
    'span_id',
    'parent_span_id',
    'is_truncated',
  ])('refuses the protected column %s', (column) => {
    expect(() => validatePayloadColumnDenylist([column])).toThrow(
      `payloadColumnDenylist may only contain content, content_parts, ` +
        `attributes, latency_ms; got ${column}.`,
    );
  });

  it('refuses a column name that does not exist at all', () => {
    expect(() => validatePayloadColumnDenylist(['contnet'])).toThrow(
      'got contnet.',
    );
  });

  it('names every rejected column, not just the first', () => {
    expect(() =>
      validatePayloadColumnDenylist(['event_id', 'content', 'user_id']),
    ).toThrow('got event_id, user_id.');
  });
});

describe('projectSchema', () => {
  it('returns every column when nothing is denied', () => {
    const projected = projectSchema(
      EVENTS_TABLE_SCHEMA,
      validatePayloadColumnDenylist([]),
    );
    expect(names(projected)).toEqual(names(EVENTS_TABLE_SCHEMA));
  });

  it('drops only the denied columns and keeps the order', () => {
    const projected = projectSchema(
      EVENTS_TABLE_SCHEMA,
      validatePayloadColumnDenylist(['content', 'latency_ms']),
    );
    expect(names(projected)).not.toContain('content');
    expect(names(projected)).not.toContain('latency_ms');
    expect(names(projected)).toContain('content_parts');
    expect(projected).toHaveLength(EVENTS_TABLE_SCHEMA.length - 2);
  });
});

describe('projectRow', () => {
  it('returns the row unchanged when nothing is denied', () => {
    const row = makeRow();
    expect(projectRow(row, validatePayloadColumnDenylist([]))).toBe(row);
  });

  it('removes the denied columns and leaves the identity columns', () => {
    const projected = projectRow(
      makeRow(),
      validatePayloadColumnDenylist(['content', 'content_parts']),
    );
    expect(projected).not.toHaveProperty('content');
    expect(projected).not.toHaveProperty('content_parts');
    expect(projected.event_id).toBe('e1');
    expect(projected.attributes).toBe('{}');
  });

  it('writes exactly the columns the projected schema declares', () => {
    const denied = validatePayloadColumnDenylist(['attributes']);
    const columns = names(projectSchema(EVENTS_TABLE_SCHEMA, denied));
    expect(Object.keys(projectRow(makeRow(), denied)).sort()).toEqual(
      [...columns].sort(),
    );
  });
});

describe('mergeSchemaFields', () => {
  it('returns undefined when the live schema already holds every column', () => {
    expect(
      mergeSchemaFields(EVENTS_TABLE_SCHEMA, EVENTS_TABLE_SCHEMA),
    ).toBeUndefined();
  });

  it('appends a missing top-level column without reordering the rest', () => {
    const live = EVENTS_TABLE_SCHEMA.slice(0, -1);
    const merged = mergeSchemaFields(live, EVENTS_TABLE_SCHEMA);
    expect(names(merged ?? [])).toEqual([...names(live), 'is_truncated']);
  });

  it('keeps a column the live table has and this version no longer writes', () => {
    const live: TableField[] = [
      {name: 'event_id', type: 'STRING', mode: 'NULLABLE'},
      {name: 'legacy', type: 'STRING', mode: 'NULLABLE'},
    ];
    const desired: TableField[] = [
      {name: 'event_id', type: 'STRING', mode: 'NULLABLE'},
      {name: 'status', type: 'STRING', mode: 'NULLABLE'},
    ];
    expect(names(mergeSchemaFields(live, desired) ?? [])).toEqual([
      'event_id',
      'legacy',
      'status',
    ]);
  });

  it('adds a missing sub-field of a RECORD column', () => {
    const live: TableField[] = [
      {
        name: 'content_parts',
        type: 'RECORD',
        mode: 'REPEATED',
        fields: [{name: 'text', type: 'STRING', mode: 'NULLABLE'}],
      },
    ];
    const desired: TableField[] = [
      {
        name: 'content_parts',
        type: 'RECORD',
        mode: 'REPEATED',
        fields: [
          {name: 'text', type: 'STRING', mode: 'NULLABLE'},
          {name: 'part_index', type: 'INTEGER', mode: 'NULLABLE'},
        ],
      },
    ];
    const merged = mergeSchemaFields(live, desired);
    expect(names(merged?.[0].fields ?? [])).toEqual(['text', 'part_index']);
  });

  it('adds a missing sub-field nested two records deep', () => {
    const live: TableField[] = [
      {
        name: 'content_parts',
        type: 'RECORD',
        mode: 'REPEATED',
        fields: [
          {
            name: 'object_ref',
            type: 'RECORD',
            mode: 'NULLABLE',
            fields: [{name: 'uri', type: 'STRING', mode: 'NULLABLE'}],
          },
        ],
      },
    ];
    const desired: TableField[] = [
      {
        name: 'content_parts',
        type: 'RECORD',
        mode: 'REPEATED',
        fields: [
          {
            name: 'object_ref',
            type: 'RECORD',
            mode: 'NULLABLE',
            fields: [
              {name: 'uri', type: 'STRING', mode: 'NULLABLE'},
              {name: 'version', type: 'STRING', mode: 'NULLABLE'},
            ],
          },
        ],
      },
    ];
    const merged = mergeSchemaFields(live, desired);
    expect(names(merged?.[0].fields?.[0].fields ?? [])).toEqual([
      'uri',
      'version',
    ]);
  });

  it('leaves a RECORD column alone when it already holds every sub-field', () => {
    const fields: TableField[] = [
      {
        name: 'content_parts',
        type: 'RECORD',
        mode: 'REPEATED',
        fields: [{name: 'text', type: 'STRING', mode: 'NULLABLE'}],
      },
    ];
    expect(mergeSchemaFields(fields, fields)).toBeUndefined();
  });

  it('refuses to retype a column the live table already has', () => {
    const live: TableField[] = [
      {name: 'content', type: 'STRING', mode: 'NULLABLE'},
    ];
    const desired: TableField[] = [
      {name: 'content', type: 'JSON', mode: 'NULLABLE'},
    ];
    expect(() => mergeSchemaFields(live, desired)).toThrow(
      'incompatible column content: the table has STRING/NULLABLE and this ' +
        'schema version writes JSON/NULLABLE.',
    );
  });

  it('refuses to change the mode of a column the live table already has', () => {
    const live: TableField[] = [
      {name: 'timestamp', type: 'TIMESTAMP', mode: 'NULLABLE'},
    ];
    const desired: TableField[] = [
      {name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED'},
    ];
    expect(() => mergeSchemaFields(live, desired)).toThrow(
      'incompatible column timestamp: the table has TIMESTAMP/NULLABLE and ' +
        'this schema version writes TIMESTAMP/REQUIRED.',
    );
  });

  it('names the full path of an incompatible sub-field', () => {
    const live: TableField[] = [
      {
        name: 'content_parts',
        type: 'RECORD',
        mode: 'REPEATED',
        fields: [{name: 'part_index', type: 'STRING', mode: 'NULLABLE'}],
      },
    ];
    const desired: TableField[] = [
      {
        name: 'content_parts',
        type: 'RECORD',
        mode: 'REPEATED',
        fields: [{name: 'part_index', type: 'INTEGER', mode: 'NULLABLE'}],
      },
    ];
    expect(() => mergeSchemaFields(live, desired)).toThrow(
      'incompatible column content_parts.part_index',
    );
  });

  it('compares the type and the mode without regard to case', () => {
    const live: TableField[] = [
      {name: 'content', type: 'json', mode: 'nullable'},
    ];
    const desired: TableField[] = [
      {name: 'content', type: 'JSON', mode: 'NULLABLE'},
    ];
    expect(mergeSchemaFields(live, desired)).toBeUndefined();
  });
});
