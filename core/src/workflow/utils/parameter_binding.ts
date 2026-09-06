/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Binds a workflow handler's declared parameters from session state or from the
 * upstream node's output.
 *
 * Ported from `google/adk-python` `workflow/_function_node.py`
 * (`_bind_parameters`, `_coerce_param`, `_content_to_str`, `_expects_str`).
 * Python reads the parameter names, types and defaults off the function
 * signature; TypeScript erases both, so the parameters are declared as an
 * object schema instead — the idiom `FunctionTool` already uses.
 */

import {Content, Schema} from '@google/genai';
import {State} from '../../sessions/state.js';
import {
  contentHasNonTextParts,
  contentToText,
  isContent,
} from '../../utils/content_utils.js';
import {logger} from '../../utils/logger.js';
import {
  objectSchemaFields,
  SchemaLike,
  toJsonSchema,
} from '../../utils/schema.js';
import {isZodObject, isZodSchema} from '../../utils/simple_zod_to_json.js';

/**
 * Where a handler's declared parameters are read from.
 *
 * `'state'` (the default) reads each declared parameter from `ctx.state`.
 * `'nodeInput'` reads them from the upstream node's output object, which also
 * makes the node usable as a `NodeTool`.
 *
 * Mirrors Python's `parameter_binding: Literal['state', 'node_input']`.
 */
export type ParameterBinding = 'state' | 'nodeInput';

/**
 * The declared parameter that receives the raw node input verbatim in
 * `'state'` mode, mirroring Python's `node_input` parameter name.
 */
export const NODE_INPUT_PARAMETER = 'nodeInput';

/** One declared parameter, resolved once from the schema at construction. */
export interface ParameterDescriptor {
  /** The parameter (and schema property) name. */
  name: string;
  /** Whether the schema lists the parameter in its `required` array. */
  required: boolean;
  /** The `default` declared by the parameter's own schema, if any. */
  defaultValue?: unknown;
  /** Whether the parameter's own schema declares a `default`. */
  hasDefault: boolean;
  /** Whether the parameter's schema is a string, or a union containing one. */
  expectsString: boolean;
  /** Validator for this parameter alone, absent when it has no Zod equivalent. */
  validate?: (value: unknown) => unknown;
}

/** A request to bind declared parameters for one node run. */
export interface BindParametersRequest {
  /** The parameters the handler declares, from {@link describeParameters}. */
  descriptors: readonly ParameterDescriptor[];
  /** Where to read the parameters from. */
  binding: ParameterBinding;
  /** The node's session state, the source in `'state'` mode. */
  state: State;
  /** The upstream node's output, the source in `'nodeInput'` mode. */
  nodeInput: unknown;
  /** The node name, used in error and warning messages. */
  nodeName: string;
}

/**
 * Resolves the parameters an object schema declares, once, so that binding a
 * value costs no schema work per run.
 *
 * Returns an empty list for a schema that declares no properties, consistent
 * with how {@link objectSchemaFields} degrades a schema it cannot decompose.
 */
export function describeParameters(schema: SchemaLike): ParameterDescriptor[] {
  const document = toJsonSchema(schema);
  const properties = document['properties'];
  if (properties === null || typeof properties !== 'object') {
    return [];
  }
  const declaredRequired = document['required'];
  const required = new Set(
    Array.isArray(declaredRequired) ? (declaredRequired as string[]) : [],
  );
  const validators = objectSchemaFields(schema);
  return Object.entries(properties as Record<string, unknown>).map(
    ([name, fieldSchema]) => {
      const field = asRecord(fieldSchema);
      const validator = validators?.get(name);
      return {
        name,
        required: required.has(name),
        defaultValue: field['default'],
        hasDefault: 'default' in field,
        expectsString: expectsString(field),
        validate: validator && ((value: unknown) => validator.parse(value)),
      };
    },
  );
}

/**
 * Reads each declared parameter from its source, applying the parameter's
 * default when it is absent and coercing it when it is present.
 *
 * A default wins over `required` because the two disagree across schema
 * dialects: Zod v4 renders a defaulted field as required (it is always present
 * in the parsed output) while Zod v3 does not.
 *
 * @throws Error when a required parameter has no value and no default.
 */
export function bindParameters(
  req: BindParametersRequest,
): Record<string, unknown> {
  const fromNodeInput = req.binding === 'nodeInput';
  const source = fromNodeInput ? asRecord(req.nodeInput) : undefined;
  const sourceName = fromNodeInput ? NODE_INPUT_PARAMETER : 'state';

  const args: Record<string, unknown> = {};
  for (const descriptor of req.descriptors) {
    if (!fromNodeInput && descriptor.name === NODE_INPUT_PARAMETER) {
      args[descriptor.name] = coerce(descriptor, req.nodeInput, req.nodeName);
      continue;
    }
    const present = source
      ? descriptor.name in source
      : req.state.has(descriptor.name);
    if (present) {
      const raw = source
        ? source[descriptor.name]
        : req.state.get(descriptor.name);
      args[descriptor.name] = coerce(descriptor, raw, req.nodeName);
    } else if (descriptor.hasDefault) {
      args[descriptor.name] = descriptor.defaultValue;
    } else if (descriptor.required) {
      throw new Error(
        `Missing value for parameter "${descriptor.name}" of function ` +
          `"${req.nodeName}". It was not found in ${sourceName} and has no ` +
          'default value.',
      );
    }
    // An optional parameter with no default is simply left unbound.
  }
  return args;
}

/**
 * Reads a `Content` bound to a string parameter as text, naming the parameter
 * in the warning when the conversion drops a non-text part.
 *
 * Never throws: a part carrying nothing this recognises is skipped, matching
 * Python's `_content_to_str`.
 */
export function contentToString(
  content: Content,
  nodeName: string,
  parameterName: string,
): string {
  if (contentHasNonTextParts(content)) {
    logger.warn(
      `Parameter "${parameterName}" of function "${nodeName}" expects a ` +
        'string but received Content with non-text parts (inlineData, ' +
        'fileData or executableCode). Non-text parts are dropped during ' +
        'auto-conversion.',
    );
  }
  return contentToText(content);
}

/**
 * Returns the schema an object schema declares for one of its properties, so a
 * `FunctionNode` can reuse a declared parameter's schema as its `inputSchema`.
 *
 * Returns `undefined` when the schema declares no such property.
 */
export function parameterFieldSchema(
  schema: SchemaLike,
  name: string,
): SchemaLike | undefined {
  if (isZodObject(schema)) {
    const field: unknown = schema.shape[name];
    return isZodSchema(field) ? field : undefined;
  }
  return (schema as Schema).properties?.[name];
}

/**
 * Coerces one bound value: a `Content` reaching a string parameter becomes its
 * text, and everything else is validated against the parameter's own schema.
 *
 * A parameter whose schema has no Zod equivalent passes its value through
 * unchanged, consistent with `parseWithSchema`.
 */
function coerce(
  descriptor: ParameterDescriptor,
  value: unknown,
  nodeName: string,
): unknown {
  if (descriptor.expectsString && isContent(value)) {
    return contentToString(value, nodeName, descriptor.name);
  }
  if (!descriptor.validate) {
    return value;
  }
  try {
    return descriptor.validate(value);
  } catch (cause) {
    throw new Error(
      `Invalid value for parameter "${descriptor.name}" of function ` +
        `"${nodeName}": ${String(cause)}`,
      {cause},
    );
  }
}

/** Reads a value as a plain object of keys, or `{}` when it is not one. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Whether a property's JSON Schema is a string, or a union containing one.
 *
 * Mirrors Python's `_expects_str`, which also accepts `Optional[str]` and any
 * other union with a `str` member. `anyOf` is how both schema serializers
 * render a union; a nullable string reaches here the same way.
 */
function expectsString(fieldSchema: unknown): boolean {
  const field = asRecord(fieldSchema);
  const type = field['type'];
  if (type === 'string' || (Array.isArray(type) && type.includes('string'))) {
    return true;
  }
  const members = field['anyOf'];
  return Array.isArray(members) && members.some(expectsString);
}
