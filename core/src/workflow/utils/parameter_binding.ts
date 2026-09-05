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
import type {z as z3} from 'zod/v3';
import type {z as z4} from 'zod/v4';
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

/** One field of a declared Zod object schema, in either dialect. */
type ZodField = z3.ZodType | z4.ZodType;

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
  /** Whether the parameter rejects an absent value. */
  required: boolean;
  /**
   * The value the parameter's schema produces for an absent input.
   *
   * Resolved once, so a handler that mutates a defaulted object reaches the
   * same object on the next run. Python's `param.default` behaves the same way.
   */
  defaultValue?: unknown;
  /** Whether the parameter's own schema declares a default. */
  hasDefault: boolean;
  /** Whether the parameter's schema is a string, or a union holding one. */
  expectsString: boolean;
  /**
   * Validator for this parameter alone. A Zod field always has one, and it is
   * the field itself, so `z.coerce`, `.transform` and `.refine` all run. A
   * property of a genai `Schema` that has no Zod equivalent has none, and its
   * value passes through unchecked — the same degradation `parseWithSchema`
   * makes, not a guarantee.
   */
  validate?: (value: unknown) => unknown;
}

/** A request to bind the declared parameters for one node run. */
interface BindParametersRequest {
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
 * Returns an empty list for a schema that declares no properties.
 */
export function describeParameters(schema: SchemaLike): ParameterDescriptor[] {
  return isZodObject(schema)
    ? describeZodParameters(schema)
    : describeDocumentParameters(schema);
}

/**
 * Describes each parameter from the Zod field that declares it.
 *
 * The field is used as its own validator, rather than being rendered as JSON
 * Schema and compiled back. The round trip erases whatever JSON Schema cannot
 * carry — `z.coerce.number()` becomes a bare `{type: 'number'}` and stops
 * coercing, and a `.refine` predicate disappears — and it throws outright for a
 * field JSON Schema cannot express at all (`z.date()`, `z.instanceof()`,
 * `.transform()`), which would abort node construction.
 */
function describeZodParameters(
  schema: z3.ZodObject<z3.ZodRawShape> | z4.ZodObject<z4.ZodRawShape>,
): ParameterDescriptor[] {
  return Object.entries(schema.shape).map(([name, field]) => {
    const absent = parseAbsent(field);
    return {
      name,
      required: !absent.accepted,
      defaultValue: absent.value,
      hasDefault: absent.accepted && absent.value !== undefined,
      expectsString: zodExpectsString(field),
      validate: (value: unknown) => field.parse(value),
    };
  });
}

/**
 * Describes each parameter of a genai `Schema` from its JSON Schema document,
 * which is the only form its properties come in.
 */
function describeDocumentParameters(schema: SchemaLike): ParameterDescriptor[] {
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
 * Asks a Zod field what it does with an absent value: whether it accepts one,
 * and the value it produces when it does.
 *
 * Optionality and defaults are read this way rather than from a `required`
 * array, because the two dialects disagree there — Zod v4 lists a defaulted
 * field as required and Zod v3 does not.
 */
function parseAbsent(field: ZodField): {accepted: boolean; value: unknown} {
  try {
    const parsed = field.safeParse(undefined);
    return {
      accepted: parsed.success,
      value: parsed.success ? parsed.data : undefined,
    };
  } catch {
    // An async refinement makes the synchronous parse throw. Treating the field
    // as required is what binding a value to it would report anyway.
    return {accepted: false, value: undefined};
  }
}

/**
 * Whether a Zod field accepts a string, so that a `Content` reaching it is
 * converted to text first.
 *
 * A field JSON Schema cannot express counts as not expecting one, which only
 * means no conversion is attempted for it.
 */
function zodExpectsString(field: ZodField): boolean {
  try {
    return expectsString(toJsonSchema(field));
  } catch {
    return false;
  }
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
