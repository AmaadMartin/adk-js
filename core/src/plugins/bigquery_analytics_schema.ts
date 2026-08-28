/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {TableField} from '@google-cloud/bigquery';
import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../agents/framework_function_calls.js';

/**
 * The wire contract of the agent analytics events table.
 *
 * Column names, types, modes and descriptions match
 * `google/adk-python`'s `bigquery_agent_analytics_plugin._get_events_schema()`
 * exactly, so one dataset can hold rows written by either SDK and a query
 * written against Python-produced rows works unchanged against JavaScript ones.
 */

/** Table schema version, written as a table label for governance. */
export const SCHEMA_VERSION = '2';

/** Label key carrying {@link SCHEMA_VERSION} on the events table. */
export const SCHEMA_VERSION_LABEL_KEY = 'adk_schema_version';

/** The `event_type` column's values. */
export enum AnalyticsEventType {
  USER_MESSAGE_RECEIVED = 'USER_MESSAGE_RECEIVED',
  INVOCATION_STARTING = 'INVOCATION_STARTING',
  INVOCATION_COMPLETED = 'INVOCATION_COMPLETED',
  AGENT_STARTING = 'AGENT_STARTING',
  AGENT_COMPLETED = 'AGENT_COMPLETED',
  AGENT_TRANSFER = 'AGENT_TRANSFER',
  AGENT_RESPONSE = 'AGENT_RESPONSE',
  LLM_REQUEST = 'LLM_REQUEST',
  LLM_RESPONSE = 'LLM_RESPONSE',
  LLM_ERROR = 'LLM_ERROR',
  TOOL_STARTING = 'TOOL_STARTING',
  TOOL_COMPLETED = 'TOOL_COMPLETED',
  TOOL_ERROR = 'TOOL_ERROR',
  TOOL_PAUSED = 'TOOL_PAUSED',
  STATE_DELTA = 'STATE_DELTA',
  AGENT_STATE_CHECKPOINT = 'AGENT_STATE_CHECKPOINT',
  NODE_OUTPUT = 'NODE_OUTPUT',
  NODE_ERROR = 'NODE_ERROR',
  HITL_CREDENTIAL_REQUEST = 'HITL_CREDENTIAL_REQUEST',
  HITL_CONFIRMATION_REQUEST = 'HITL_CONFIRMATION_REQUEST',
  HITL_INPUT_REQUEST = 'HITL_INPUT_REQUEST',
  HITL_CREDENTIAL_REQUEST_COMPLETED = 'HITL_CREDENTIAL_REQUEST_COMPLETED',
  HITL_CONFIRMATION_REQUEST_COMPLETED = 'HITL_CONFIRMATION_REQUEST_COMPLETED',
  HITL_INPUT_REQUEST_COMPLETED = 'HITL_INPUT_REQUEST_COMPLETED',
  // The four below name rows adk-python writes into a shared table and this
  // SDK does not, each because adk-js has no source for them: `BasePlugin` has
  // no `onAgentErrorCallback` or `onRunErrorCallback`, `EventActions` has no
  // `compaction` field, and agent-to-agent capture is out of scope. They are
  // declared because this enum is the reader's vocabulary for the column, not
  // just the writer's: a consumer enumerating it must cover every row the
  // table can hold, whichever SDK wrote it.
  AGENT_ERROR = 'AGENT_ERROR',
  INVOCATION_ERROR = 'INVOCATION_ERROR',
  EVENT_COMPACTION = 'EVENT_COMPACTION',
  A2A_INTERACTION = 'A2A_INTERACTION',
}

/** The `attributes.adk.pause_kind` value for a non-HITL long-running tool. */
export const TOOL_PAUSE_KIND = 'tool';

/** How one framework `adk_request_*` call appears in the taxonomy. */
export interface HitlMapping {
  /** The framework function call name this entry matches. */
  name: string;
  /** Written when the agent raises the request. */
  request: AnalyticsEventType;
  /** Written when a client answers the request. */
  completed: AnalyticsEventType;
  /** The `attributes.adk.pause_kind` value for the paused call. */
  pauseKind: string;
}

const HITL_MAPPINGS: ReadonlyMap<string, HitlMapping> = new Map(
  (
    [
      {
        name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
        request: AnalyticsEventType.HITL_CREDENTIAL_REQUEST,
        completed: AnalyticsEventType.HITL_CREDENTIAL_REQUEST_COMPLETED,
        pauseKind: 'hitl_credential',
      },
      {
        name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
        request: AnalyticsEventType.HITL_CONFIRMATION_REQUEST,
        completed: AnalyticsEventType.HITL_CONFIRMATION_REQUEST_COMPLETED,
        pauseKind: 'hitl_confirmation',
      },
      {
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        request: AnalyticsEventType.HITL_INPUT_REQUEST,
        completed: AnalyticsEventType.HITL_INPUT_REQUEST_COMPLETED,
        pauseKind: 'hitl_input',
      },
    ] as const
  ).map((mapping) => [mapping.name, mapping]),
);

/**
 * The taxonomy entry for a function call or response name.
 *
 * The name decides the kind, not the call id: a client answers a request by
 * name, and an id carries no information about what was asked.
 *
 * @param name The function call or response name.
 * @return The mapping, or undefined when the name is an ordinary tool.
 */
export function hitlMappingFor(
  name: string | undefined,
): HitlMapping | undefined {
  return name === undefined ? undefined : HITL_MAPPINGS.get(name);
}

/** The `status` column's values. */
export enum AnalyticsStatus {
  OK = 'OK',
  ERROR = 'ERROR',
}

/**
 * Version of the `attributes.adk` envelope every row carries.
 *
 * Separate from {@link SCHEMA_VERSION}: the table's columns and the envelope
 * inside the `attributes` column change independently, and a consumer gates on
 * whichever one it reads.
 */
export const ADK_ENVELOPE_SCHEMA_VERSION = '1';

/** The `attributes.adk.scope.kind` values, in the order they are tested. */
export enum AnalyticsScopeKind {
  /** The scope names one run of a workflow node. */
  NODE_RUN = 'node_run',
  /** The scope names one function call. */
  FUNCTION_CALL = 'function_call',
  /** The scope is present but is not a name this SDK recognizes. */
  UNKNOWN = 'unknown',
}

/** The `attributes.adk.scope` object. */
export interface AnalyticsScope {
  id: string;
  kind: AnalyticsScopeKind;
}

/** The `attributes.adk.node` object. */
export interface AnalyticsNode {
  path: string | null;
  run_id: string | null;
  parent_run_id: string | null;
}

/** Separator between the segments of a workflow node path. */
const NODE_PATH_SEPARATOR = '/';

/** Separator between a node name and the id of one run of it. */
const NODE_RUN_SEPARATOR = '@';

/** The run id a path segment carries, or null when it names no run. */
function runIdOf(segment: string | undefined): string | null {
  if (segment === undefined) {
    return null;
  }
  const at = segment.indexOf(NODE_RUN_SEPARATOR);
  return at === -1 ? null : segment.slice(at + 1);
}

/**
 * Reads the run id and the parent run id out of a workflow node path.
 *
 * A path is `/`-separated and each segment may carry `@<runId>`, so
 * `wf/a@1/b@2` ran node `b` as run `2` inside run `1`. adk-js `NodeInfo` stores
 * only the path where adk-python stores the two ids as well, so the emitted
 * JSON keeps Python's shape by deriving them here.
 *
 * @param path The node path, possibly empty.
 * @return The run id of the last segment and of the one before it.
 */
export function parseNodeRunIds(path: string): {
  run_id: string | null;
  parent_run_id: string | null;
} {
  const segments = path.split(NODE_PATH_SEPARATOR);
  return {
    run_id: runIdOf(segments.at(-1)),
    parent_run_id: runIdOf(segments.length > 1 ? segments.at(-2) : undefined),
  };
}

/**
 * Classifies an event's isolation scope for `attributes.adk.scope`.
 *
 * The order is load-bearing: a scope whose last path segment carries `@` names
 * a node run, and testing that first stops a bare `name@runId` from reading as
 * a function call.
 *
 * @param value The isolation scope, of whatever type the event carried. A
 *     rehydrated event supplies it from storage, so it is not always a string.
 * @return The scope object, or null when the event carries no scope.
 */
export function deriveScope(value: unknown): AnalyticsScope | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value === '') {
    return {id: String(value), kind: AnalyticsScopeKind.UNKNOWN};
  }
  const last = value.slice(value.lastIndexOf(NODE_PATH_SEPARATOR) + 1);
  return {
    id: value,
    kind: last.includes(NODE_RUN_SEPARATOR)
      ? AnalyticsScopeKind.NODE_RUN
      : AnalyticsScopeKind.FUNCTION_CALL,
  };
}

/** The `content_parts.storage_mode` column's values. */
export enum AnalyticsStorageMode {
  INLINE = 'INLINE',
  EXTERNAL_URI = 'EXTERNAL_URI',
}

/** One entry of the repeated `content_parts` column. */
export interface AnalyticsContentPart {
  mime_type: string;
  uri: string | null;
  /**
   * Always null. The column exists so the table matches a Python-written one;
   * populating it needs the Cloud Storage offload path, which this plugin does
   * not implement.
   */
  object_ref: null;
  text: string | null;
  part_index: number;
  part_attributes: string;
  storage_mode: AnalyticsStorageMode;
}

/** One row of the events table, in the column order the schema declares. */
export interface AnalyticsRow {
  timestamp: string;
  event_id: string;
  event_type: AnalyticsEventType;
  agent: string | null;
  session_id: string;
  invocation_id: string;
  user_id: string;
  trace_id: string;
  span_id: string | null;
  parent_span_id: string | null;
  /** JSON-encoded, because BigQuery `JSON` columns are supplied as strings. */
  content: string | null;
  content_parts: AnalyticsContentPart[];
  /** JSON-encoded. */
  attributes: string;
  /** JSON-encoded. */
  latency_ms: string | null;
  status: AnalyticsStatus;
  error_message: string | null;
  is_truncated: boolean;
}

/** Sub-fields of the repeated `content_parts` column. */
const CONTENT_PART_FIELDS: TableField[] = [
  {
    name: 'mime_type',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      "The MIME type of the content part (e.g., 'text/plain', 'image/png').",
  },
  {
    name: 'uri',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      'The URI of the content part if stored externally (e.g., GCS bucket path).',
  },
  {
    name: 'object_ref',
    type: 'RECORD',
    mode: 'NULLABLE',
    description: 'The ObjectRef of the content part if stored externally.',
    fields: [
      {
        name: 'uri',
        type: 'STRING',
        mode: 'NULLABLE',
        description: 'The URI of the object.',
      },
      {
        name: 'version',
        type: 'STRING',
        mode: 'NULLABLE',
        description: 'The version of the object.',
      },
      {
        name: 'authorizer',
        type: 'STRING',
        mode: 'NULLABLE',
        description: 'The authorizer for the object.',
      },
      {
        name: 'details',
        type: 'JSON',
        mode: 'NULLABLE',
        description: 'Additional details about the object.',
      },
    ],
  },
  {
    name: 'text',
    type: 'STRING',
    mode: 'NULLABLE',
    description: 'The raw text content if the part is text-based.',
  },
  {
    name: 'part_index',
    type: 'INTEGER',
    mode: 'NULLABLE',
    description: 'The zero-based index of this part within the content.',
  },
  {
    name: 'part_attributes',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      'Additional metadata for this content part as a JSON object (serialized to string).',
  },
  {
    name: 'storage_mode',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      "Indicates how the content part is stored (e.g., 'INLINE', 'GCS_REFERENCE', 'EXTERNAL_URI').",
  },
];

/** The 17 columns of the events table. */
export const EVENTS_TABLE_SCHEMA: TableField[] = [
  {
    name: 'timestamp',
    type: 'TIMESTAMP',
    mode: 'REQUIRED',
    description:
      'The UTC timestamp when the event occurred. Used for ordering events within a session.',
  },
  {
    name: 'event_id',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      'A unique identifier assigned before enqueue. This SDK sends it as the insert id of the row, so a retried insert of the same row is de-duplicated on a best-effort basis.',
  },
  {
    name: 'event_type',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      "The category of the event (e.g., 'LLM_REQUEST', 'TOOL_CALL', 'AGENT_RESPONSE'). Helps in filtering specific types of interactions.",
  },
  {
    name: 'agent',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      'The name of the agent that generated this event. Useful for multi-agent systems.',
  },
  {
    name: 'session_id',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      'A unique identifier for the entire conversation session. Used to group all events belonging to a single user interaction.',
  },
  {
    name: 'invocation_id',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      'A unique identifier for a single turn or execution within a session. Groups related events like LLM request and response.',
  },
  {
    name: 'user_id',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      'The identifier of the end-user participating in the session, if available.',
  },
  {
    name: 'trace_id',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      'OpenTelemetry trace ID for distributed tracing across services.',
  },
  {
    name: 'span_id',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      "BQAA-internal execution-tree span id for this operation. This is the plugin's own correlation id used with parent_span_id to reconstruct the agent/LLM/tool tree -- NOT the OpenTelemetry span id, except on the root/invocation row where it may reuse the ambient OTel span id. For span-level Cloud Trace correlation use attributes.otel.span_id (best-effort).",
  },
  {
    name: 'parent_span_id',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      'BQAA-internal parent execution-tree span id, used to reconstruct the operation hierarchy. Points at another BQAA row, not an OpenTelemetry parent span.',
  },
  {
    name: 'content',
    type: 'JSON',
    mode: 'NULLABLE',
    description:
      'The primary payload of the event, stored as a JSON string. The structure depends on the event_type (e.g., prompt text for LLM_REQUEST, tool output for TOOL_RESPONSE).',
  },
  {
    name: 'content_parts',
    type: 'RECORD',
    mode: 'REPEATED',
    description:
      'For multi-modal events, contains a list of content parts (text, images, etc.).',
    fields: CONTENT_PART_FIELDS,
  },
  {
    name: 'attributes',
    type: 'JSON',
    mode: 'NULLABLE',
    description:
      "A JSON object containing arbitrary key-value pairs for additional event metadata. Includes enrichment fields like 'root_agent_name' (turn orchestration), 'model' (request model), 'model_version' (response version), and 'usage_metadata' (detailed token counts). May also carry 'otel' (best-effort ambient Cloud Trace span/trace ids).",
  },
  {
    name: 'latency_ms',
    type: 'JSON',
    mode: 'NULLABLE',
    description:
      "A JSON object containing latency measurements, such as 'total_ms' and 'time_to_first_token_ms'.",
  },
  {
    name: 'status',
    type: 'STRING',
    mode: 'NULLABLE',
    description: "The outcome of the event, typically 'OK' or 'ERROR'.",
  },
  {
    name: 'error_message',
    type: 'STRING',
    mode: 'NULLABLE',
    description:
      "Diagnostic message for errors and model termination details; may be populated on LLM_RESPONSE rows whose status is 'OK'.",
  },
  {
    name: 'is_truncated',
    type: 'BOOLEAN',
    mode: 'NULLABLE',
    description:
      "Boolean flag indicating if the content or metadata payload was truncated because it exceeded the maximum allowed size. Set when 'content', captured 'custom_metadata', or A2A metadata is truncated; redaction of sensitive keys does not set this flag.",
  },
];
