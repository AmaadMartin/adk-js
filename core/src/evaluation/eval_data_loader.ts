/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import {z} from 'zod';

import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {
  toCamelCase,
  toCamelCaseKey,
  toSnakeCase,
} from '../utils/object_notation_utils.js';

import {EvalConfig} from './eval_config.js';
import {PrebuiltMetrics} from './eval_metrics.js';
import {EvalSet, EvalSetSchema} from './eval_set.js';

/**
 * Metric names the registry resolves but adk-js cannot score.
 *
 * Their evaluators call the Vertex Gen AI Eval service, which adk-js does not
 * ship, so each one throws when it runs. adk-python allows them because it can
 * reach that service.
 */
export const UNSUPPORTED_METRICS: readonly string[] = [
  PrebuiltMetrics.RESPONSE_EVALUATION_SCORE,
  PrebuiltMetrics.SAFETY_V1,
];

/**
 * Metric names an eval config may use with a legacy-format test file.
 *
 * Mirrors adk-python's `ALLOWED_CRITERIA`, less {@link UNSUPPORTED_METRICS}.
 * Richer metrics exist in the registry but need data the legacy format cannot
 * express.
 */
export const ALLOWED_CRITERIA: readonly string[] = [
  PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
  PrebuiltMetrics.RESPONSE_MATCH_SCORE,
];

const QUERY_COLUMN = 'query';
const REFERENCE_COLUMN = 'reference';
const EXPECTED_TOOL_USE_COLUMN = 'expected_tool_use';

/**
 * Paths whose values hold user-defined keys and must never be case-converted
 * when an eval set is read from disk. Expressed in the on-disk snake_case
 * spelling.
 */
const PRESERVE_KEYS_SNAKE_CASE = [
  'eval_cases.session_input.state',
  'eval_cases.final_session_state',
  'eval_cases.conversation.user_content.parts.function_call.args',
  'eval_cases.conversation.user_content.parts.function_response.response',
  'eval_cases.conversation.final_response.parts.function_call.args',
  'eval_cases.conversation.final_response.parts.function_response.response',
  'eval_cases.conversation.intermediate_data.tool_uses.args',
  'eval_cases.conversation.intermediate_data.tool_responses.response',
];

/**
 * The camelCase counterparts of {@link PRESERVE_KEYS_SNAKE_CASE}, used when
 * writing an eval set back to disk.
 */
const PRESERVE_KEYS_CAMEL_CASE = PRESERVE_KEYS_SNAKE_CASE.map(toCamelCaseKey);

/**
 * Preserve paths for reading. An eval set file may spell its own field names in
 * either case, and the path a key is matched on follows the spelling in the
 * file, so both lists apply on read.
 */
const PRESERVE_KEYS_ON_READ = [
  ...PRESERVE_KEYS_SNAKE_CASE,
  ...PRESERVE_KEYS_CAMEL_CASE,
];

/**
 * A tool call in the legacy eval file format.
 *
 * The legacy format is written with fixed snake_case keys, so it is parsed
 * verbatim rather than through the generic key converter.
 */
export const LegacyToolUseSchema = z
  .object({
    /** The tool name, mapped to `FunctionCall.name`. */
    tool_name: z.string(),
    /** The tool arguments, mapped to `FunctionCall.args` unchanged. */
    tool_input: z.record(z.string(), z.unknown()).default(() => ({})),
  })
  .loose();

/** A tool call in the legacy eval file format. */
export type LegacyToolUse = z.infer<typeof LegacyToolUseSchema>;

/** An intermediate agent response in the legacy eval file format. */
export const LegacyIntermediateResponseSchema = z
  .object({
    /** The sub-agent that produced the response. */
    author: z.string(),
    /** The response text. */
    text: z.string(),
  })
  .loose();

/** An intermediate agent response in the legacy eval file format. */
export type LegacyIntermediateResponse = z.infer<
  typeof LegacyIntermediateResponseSchema
>;

/** A single recorded turn in the legacy eval file format. */
export const LegacyInvocationSchema = z
  .object({
    /** The user query for this turn. */
    query: z.string(),
    /** The expected final response. */
    reference: z.string().default(''),
    /** The expected tool calls, in order. */
    expected_tool_use: z.array(LegacyToolUseSchema).default(() => []),
    /** The expected intermediate sub-agent responses. */
    expected_intermediate_agent_responses: z
      .array(LegacyIntermediateResponseSchema)
      .default(() => []),
  })
  .loose();

/** A single recorded turn in the legacy eval file format. */
export type LegacyInvocation = z.infer<typeof LegacyInvocationSchema>;

/** The initial session in the legacy eval file format. */
export const LegacyInitialSessionSchema = z
  .object({
    /** The app name of the session. */
    app_name: z.string().default(''),
    /** The user id of the session. */
    user_id: z.string().default(''),
    /** The session state, carried over with its keys unchanged. */
    state: z.record(z.string(), z.unknown()).default(() => ({})),
  })
  .loose();

/** The initial session in the legacy eval file format. */
export type LegacyInitialSession = z.infer<typeof LegacyInitialSessionSchema>;

/** An eval case in the legacy eval file format. */
export interface LegacyEvalCase {
  /** The eval case id. */
  name: string;
  /** The recorded conversation. */
  data: LegacyInvocation[];
  /** Session values shared by the whole case. */
  initial_session?: LegacyInitialSession;
}

/** The whole legacy file: a JSON array of recorded turns. */
const LegacyFileSchema = z.array(LegacyInvocationSchema);

function nowSeconds(): number {
  return Date.now() / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rejects an eval config whose criteria do not line up with a legacy-format
 * dataset. Only the first recorded turn is inspected, as in adk-python.
 *
 * @param dataset The parsed legacy file: an array of recorded turns.
 * @param criteria The criteria map from the eval config.
 * @throws {Error} If a criteria key is not in {@link ALLOWED_CRITERIA}, if the
 *     dataset is not a non-empty array of objects, or if the first turn is
 *     missing a column a configured metric needs.
 */
export function validateLegacyInput(
  dataset: unknown,
  criteria: Record<string, unknown>,
): void {
  for (const key of Object.keys(criteria)) {
    if (!ALLOWED_CRITERIA.includes(key)) {
      throw new Error(
        `Invalid criteria key: ${key}. Expected one of` +
          ` ${ALLOWED_CRITERIA.join(', ')}.`,
      );
    }
  }

  if (!Array.isArray(dataset) || dataset.length === 0) {
    throw new Error('The evaluation dataset is None or empty.');
  }

  const firstQuery: unknown = dataset[0];
  if (!isRecord(firstQuery)) {
    throw new Error(
      'Each evaluation dataset sample must be a list of objects. But it is' +
        ` ${JSON.stringify(dataset)}.`,
    );
  }

  const requiredColumns: Array<[string, string[]]> = [
    [
      PrebuiltMetrics.TOOL_TRAJECTORY_AVG_SCORE,
      [QUERY_COLUMN, EXPECTED_TOOL_USE_COLUMN],
    ],
    [PrebuiltMetrics.RESPONSE_MATCH_SCORE, [QUERY_COLUMN, REFERENCE_COLUMN]],
  ];

  for (const [metricName, columns] of requiredColumns) {
    if (!(metricName in criteria)) {
      continue;
    }
    const missing = columns.filter((column) => !(column in firstQuery));
    if (missing.length > 0) {
      throw new Error(
        `Samples for ${metricName} must include ${columns.join(' and ')}` +
          ` keys. The sample is ${JSON.stringify(firstQuery)}.`,
      );
    }
  }
}

function convertLegacyInvocation(invocation: LegacyInvocation) {
  return {
    invocationId: randomUUID(),
    userContent: {parts: [{text: invocation.query}], role: 'user'},
    finalResponse: {parts: [{text: invocation.reference}], role: 'model'},
    intermediateData: {
      toolUses: invocation.expected_tool_use.map((toolUse) => ({
        name: toolUse.tool_name,
        args: toolUse.tool_input,
      })),
      toolResponses: [],
      intermediateResponses:
        invocation.expected_intermediate_agent_responses.map((response) => [
          response.author,
          [{text: response.text}],
        ]),
    },
    creationTimestamp: nowSeconds(),
  };
}

/**
 * Converts eval cases in the legacy file format into an {@link EvalSet}.
 *
 * @param evalSetId The id to give the resulting eval set.
 * @param legacyEvalCases The legacy eval cases to convert.
 */
export function convertLegacyEvalSet(
  evalSetId: string,
  legacyEvalCases: LegacyEvalCase[],
): EvalSet {
  const evalCases = legacyEvalCases.map((legacyEvalCase) => {
    const initialSession = legacyEvalCase.initial_session;
    const sessionInput = initialSession && {
      appName: initialSession.app_name,
      userId: initialSession.user_id,
      state: initialSession.state,
    };

    return {
      evalId: legacyEvalCase.name,
      conversation: legacyEvalCase.data.map(convertLegacyInvocation),
      sessionInput,
      creationTimestamp: nowSeconds(),
    };
  });

  return EvalSetSchema.parse({
    evalSetId,
    name: evalSetId,
    creationTimestamp: nowSeconds(),
    evalCases,
  });
}

function readJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Input path ${filePath} is invalid.`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Reads the session values shared by every case in a legacy-format eval file.
 *
 * @param initialSessionFile Path to a JSON object in the legacy
 *     `{app_name, user_id, state}` spelling. Omit it when there are none.
 */
export function readInitialSessionFile(
  initialSessionFile?: string,
): Record<string, unknown> {
  if (!initialSessionFile) {
    return {};
  }
  const parsed: unknown = readJsonFile(initialSessionFile);
  if (!isRecord(parsed)) {
    throw new Error(
      `Initial session file ${initialSessionFile} must hold a JSON object.`,
    );
  }
  return parsed;
}

/**
 * Reads an {@link EvalSet} from a `*.test.json` file written by either SDK.
 *
 * The eval set schema is tried first, accepting both the snake_case spelling
 * adk-python writes and the camelCase spelling adk-js uses in process. A file
 * that does not validate is read as the legacy array format instead.
 *
 * @param evalSetFile Path to the eval file.
 * @param evalConfig The eval config that applies to this file, used to validate
 *     a legacy-format file.
 * @param initialSession Session values shared by every case in a legacy-format
 *     file, in the legacy `{app_name, user_id, state}` spelling. Pass `{}` when
 *     there are none.
 * @throws {Error} If the path is not a file, or if a valid eval set file is
 *     combined with a non-empty `initialSession`.
 * @throws {SyntaxError} If the file does not hold valid JSON.
 */
export function loadEvalSetFromFile(
  evalSetFile: string,
  evalConfig: EvalConfig,
  initialSession: Record<string, unknown>,
): EvalSet {
  const parsed: unknown = readJsonFile(evalSetFile);
  const asEvalSet = EvalSetSchema.safeParse(
    toCamelCase(parsed, PRESERVE_KEYS_ON_READ, /* dropNulls= */ true),
  );

  if (asEvalSet.success) {
    if (Object.keys(initialSession).length > 0) {
      throw new Error(
        'Initial session should be specified as a part of the EvalSet file.' +
          ' An explicit initial session is only needed when specifying data' +
          ' in the older schema.',
      );
    }
    return asEvalSet.data;
  }

  logger.warn(
    `Contents of ${evalSetFile} appear to be in the older format. To avoid` +
      ' this warning, please update your test files to contain data in the' +
      ' EvalSet schema. You can use `migrateEvalDataToNewSchema` for' +
      ' migrating your old test files.',
  );

  validateLegacyInput(parsed, evalConfig.criteria);
  return convertLegacyEvalSet(randomUUID(), [
    {
      name: evalSetFile,
      data: LegacyFileSchema.parse(parsed),
      initial_session:
        Object.keys(initialSession).length > 0
          ? LegacyInitialSessionSchema.parse(initialSession)
          : undefined,
    },
  ]);
}

/**
 * Serializes an {@link EvalSet} to the on-disk snake_case JSON that adk-python
 * reads, matching its two-space indentation.
 */
export function toEvalSetJson(evalSet: EvalSet): string {
  return JSON.stringify(
    toSnakeCase(evalSet, PRESERVE_KEYS_CAMEL_CASE),
    null,
    2,
  );
}
