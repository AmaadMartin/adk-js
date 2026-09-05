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
 * (`_bind_parameters`, `_coerce_param`, `_content_to_str`, `_expects_str`) at
 * `main` `25f5214c`. Python reads parameter names, types and defaults off the
 * function signature; TypeScript erases all three at runtime, so the caller
 * declares them as an object schema instead — the idiom `FunctionTool` already
 * uses for the same reason.
 */

import {Content, Schema} from '@google/genai';
import {State} from '../../sessions/state.js';
import {logger} from '../../utils/logger.js';
import {
  objectSchemaFields,
  SchemaLike,
  toJsonSchema,
} from '../../utils/schema.js';
import {isZodObject, isZodSchema} from '../../utils/simple_zod_to_json.js';
import {isContent} from '../base_node.js';

/**
 * Where a handler's declared parameters are read from.
 *
 * `'state'` (the default) reads each declared parameter from `ctx.state`.
 * `'nodeInput'` reads them from the upstream node's output object, which also
 * makes the node usable as a `NodeTool` without restating its schema.
 *
 * Mirrors Python's `parameter_binding: Literal['state', 'node_input']`.
 */
export type ParameterBinding = 'state' | 'nodeInput';

/**
 * The declared parameter that receives the raw node input verbatim in
 * `'state'` mode, mirroring Python's identically-special `node_input`
 * parameter.
 */
export const NODE_INPUT_PARAMETER = 'nodeInput';

/** One declared parameter, resolved once from the schema at construction. */
export interface ParameterDescriptor {
  /** The parameter, and the schema property, name. */
  name: string;
  /** Whether the schema lists the parameter in its `required` array. */
  required: boolean;
  /** The `default` the parameter's own schema declares, if any. */
  defaultValue?: unknown;
  /** Whether the parameter's own schema declares a `default`. */
  hasDefault: boolean;
  /** Whether the parameter's schema is a string, or a union holding one. */
  expectsString: boolean;
  /**
   * Validator for this parameter alone. Absent when the parameter's schema has
   * no Zod equivalent, in which case its value passes through unchecked — the
   * same degradation `parseWithSchema` makes, not a guarantee.
   */
  validate?: (value: unknown) => unknown;
}

/** A request to bind the declared parameters for one node run. */
export interface BindParametersRequest {
  /** The parameters the handler declares, from {@link describeParameters}. */
  descriptors: readonly ParameterDescriptor[];
  /** Where to read the parameters from. */
  binding: ParameterBinding;
  /** The node's session state, the source in `'state'` mode. */
  state: State;
  /** The upstream node's output, the source in `'nodeInput'` mode. */
  nodeInput: unknown;
  /** The node name, used in the error and warning messages. */
  nodeName: string;
}

/**
 * Resolves the parameters an object schema declares, so that binding a value
 * costs no schema work per run.
 *
 * Returns an empty list for a schema that declares no properties, the way
 * {@link objectSchemaFields} degrades a schema it cannot decompose.
 */
export function describeParameters(schema: SchemaLike): ParameterDescriptor[] {
  const document = toJsonSchema(schema);
  const properties = asRecord(document['properties']);
  const declaredRequired = document['required'];
  const required = new Set(
    Array.isArray(declaredRequired) ? (declaredRequired as string[]) : [],
  );
  const validators = objectSchemaFields(schema);
  return Object.entries(properties).map(([name, fieldSchema]) => {
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
  });
}

/**
 * Reads each declared parameter from its source, applying the parameter's own
 * default when it is absent and coercing it when it is present.
 *
 * A declared default wins over `required`, because the two schema dialects
 * disagree: Zod v4 renders a defaulted field as required (it is always present
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
    const {present, value} = readParameter(req, source, descriptor.name);
    if (present) {
      args[descriptor.name] = coerce(descriptor, value, req.nodeName);
    } else if (descriptor.hasDefault) {
      args[descriptor.name] = descriptor.defaultValue;
    } else if (descriptor.required) {
      throw new Error(
        `Missing value for parameter "${descriptor.name}" of function ` +
          `"${req.nodeName}". It was not found in ${sourceName} and has no ` +
          'default value.',
      );
    }
    // An optional parameter with no default is left unbound.
  }
  return args;
}

/**
 * Joins the text parts of a `Content`, warning when it drops non-text parts.
 *
 * Never throws: a part carrying nothing this recognises is skipped, the way
 * Python's `_content_to_str` skips it.
 */
export function contentToString(
  content: Content,
  nodeName: string,
  parameterName: string,
): string {
  const texts: string[] = [];
  let dropped = false;
  for (const part of content.parts ?? []) {
    if (part.text !== undefined && part.text !== null) {
      texts.push(part.text);
    } else if (part.inlineData || part.fileData || part.executableCode) {
      dropped = true;
    }
  }
  if (dropped) {
    logger.warn(
      `Parameter "${parameterName}" of function "${nodeName}" expects a ` +
        'string but received Content with non-text parts (inlineData, ' +
        'fileData or executableCode). Non-text parts are dropped during ' +
        'auto-conversion.',
    );
  }
  return texts.join('');
}

/**
 * Returns the schema an object schema declares for one of its properties, so a
 * node can reuse a declared parameter's schema as its own `inputSchema`.
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
 * Reads one parameter from its source: whether the source holds it, and the
 * value it holds.
 *
 * `source` is present only in `'nodeInput'` mode. In `'state'` mode the
 * parameter literally named `nodeInput` receives the raw node input instead of
 * a state entry, mirroring Python's identically-special `node_input`. An
 * absent node input counts as absent, so the parameter falls to its default or
 * is left unbound rather than being validated as `undefined`.
 */
function readParameter(
  req: BindParametersRequest,
  source: Record<string, unknown> | undefined,
  name: string,
): {present: boolean; value: unknown} {
  if (!source && name === NODE_INPUT_PARAMETER) {
    return {present: req.nodeInput !== undefined, value: req.nodeInput};
  }
  if (source) {
    return {present: name in source, value: source[name]};
  }
  return {present: req.state.has(name), value: req.state.get(name)};
}

/**
 * Coerces one bound value: a `Content` reaching a string parameter becomes its
 * text, and every other value is checked against the parameter's own schema.
 *
 * The conversion runs before validation, so a string parameter fed the user's
 * `Content` from `START` sees text rather than an object.
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
 * Whether a property's JSON Schema is a string, or a union holding one.
 *
 * Mirrors Python's `_expects_str`, which also accepts `Optional[str]` and any
 * other union with a `str` member. Zod v4 renders a union as `anyOf` and Zod v3
 * renders it as a `type` array, so both forms reach here.
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
