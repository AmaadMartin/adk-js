/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Building a publish tool whose CloudEvent attributes are bound in advance.
 *
 * The generic `publish_message` tool asks the model for every attribute. A
 * domain-specific tool locks the attributes the application already knows —
 * to a constant, or to a function of the payload — and asks the model only
 * for what is left.
 */

import {z} from 'zod';
import type {Context} from '../../agents/context.js';
import {InputValidationError} from '../../errors/input_validation_error.js';
import {FunctionTool} from '../../tools/function_tool.js';
import type {EventarcToolConfig} from './config.js';
import type {EventarcCredentialsConfig} from './eventarc_credentials.js';
import {
  publishMessage,
  type PublishMessageInput,
  type PublishMessageResult,
} from './message_tool.js';

/** Leave this attribute off the published CloudEvent. */
export const OMIT: unique symbol = Symbol('OMIT');

/** The CloudEvent attributes a binding may name, other than custom ones. */
const RESERVED_ATTRIBUTES = [
  'type',
  'source',
  'datacontenttype',
  'subject',
  'time',
  'specversion',
  'id',
] as const;

/** A reserved CloudEvent attribute name. */
type ReservedAttribute = (typeof RESERVED_ATTRIBUTES)[number];

/** The attributes that must resolve to a value. */
const MANDATORY_ATTRIBUTES: ReservedAttribute[] = ['type', 'source'];

/** The attributes that may be configured but must never resolve to `OMIT`. */
const NON_OMITTABLE_ATTRIBUTES: ReservedAttribute[] = ['id', 'specversion'];

/**
 * The attributes whose "leave it off" signal `publishMessage` spells as an
 * empty string.
 */
const EMPTY_STRING_OMITS: ReservedAttribute[] = ['time', 'datacontenttype'];

/** A custom attribute key, which CloudEvents restricts to [a-z0-9]. */
const LOWERCASE_ALPHANUMERIC_PATTERN = /^[a-z0-9]+$/;

/** The tool parameter carrying the event payload. */
const PAYLOAD_PARAMETER = 'event_data';

/**
 * A value the model supplies when it calls the tool.
 *
 * Without a `default` the model must supply it. With one, the parameter is
 * optional and the default applies when the model leaves it out.
 */
export class AgentProvided {
  /** What the model is told the attribute means. */
  readonly description: string;
  /** Used when the model supplies nothing. */
  readonly default?: string | typeof OMIT;

  constructor(options: {description: string; default?: string | typeof OMIT}) {
    this.description = options.description;
    this.default = options.default;
  }
}

/**
 * Computes an attribute when the tool runs.
 *
 * Both arguments are always passed, in this order. To read only the context,
 * name the payload and ignore it: `(_payload, ctx) => ...`.
 */
export type AttributeResolver<T> = (
  payload?: unknown,
  toolContext?: Context,
) => T;

/**
 * What a CloudEvent attribute is bound to.
 *
 * `OMIT` is accepted by the type and rejected at build time for the
 * attributes that cannot be left off, so a JavaScript caller gets the same
 * error a TypeScript caller does.
 */
export type AttributeBinding =
  | string
  | AttributeResolver<string | typeof OMIT>
  | AgentProvided
  | typeof OMIT;

/** Which CloudEvent attribute takes which value. */
export interface CloudEventAttributesBinding {
  /** Required. Must not be `OMIT`. */
  type: AttributeBinding;
  /** Required. Must not be `OMIT`. */
  source: AttributeBinding;
  datacontenttype?: AttributeBinding;
  subject?: AttributeBinding;
  time?: AttributeBinding;
  /** Must not be `OMIT`; the event always carries a spec version. */
  specversion?: AttributeBinding;
  /** Must not be `OMIT`; the event always carries an id. */
  id?: AttributeBinding;
  customAttributes?: Record<string, AttributeBinding>;
}

/** How to build a domain-specific publish tool. */
export interface CreatePublishToolOptions {
  /** The name the model calls the tool by. */
  name: string;
  /** What the model is told the tool does. */
  description: string;
  /** The message bus to publish to. Must not be `OMIT`. */
  bus: AttributeBinding;
  /** Which CloudEvent attributes take which values. */
  ceAttributesBinding: CloudEventAttributesBinding;
  /** The shape of the event payload, asked of the model as `event_data`. */
  payloadSchema?: z.ZodType;
}

/** What the toolset binds to a domain-specific tool, out of the model's reach. */
export interface DomainSpecificToolOptions {
  credentialsConfig?: EventarcCredentialsConfig;
  toolConfig?: EventarcToolConfig;
}

/** Whether a binding is a function to call rather than a value to use. */
function isResolver(
  binding: unknown,
): binding is AttributeResolver<string | typeof OMIT> {
  return typeof binding === 'function';
}

/** Rejects a `bus` binding that cannot produce a value. */
function validateBus(bus: AttributeBinding): void {
  if (bus === undefined || bus === null) {
    throw new InputValidationError(
      "The 'bus' parameter is mandatory and must be provided.",
    );
  }
  if (bus === OMIT) {
    throw new InputValidationError(
      "The 'bus' parameter is mandatory and cannot be OMIT.",
    );
  }
}

/** Rejects reserved attributes that are absent or wrongly set to `OMIT`. */
function validateReservedAttributes(
  binding: CloudEventAttributesBinding,
): void {
  for (const field of MANDATORY_ATTRIBUTES) {
    const value = binding[field];
    if (value === undefined || value === null) {
      throw new InputValidationError(
        `CloudEventAttributesBinding requires '${field}' to be provided.`,
      );
    }
    if (value === OMIT) {
      throw new InputValidationError(
        `CloudEvent field '${field}' is mandatory and cannot be OMIT.`,
      );
    }
  }
  for (const field of NON_OMITTABLE_ATTRIBUTES) {
    if (binding[field] === OMIT) {
      throw new InputValidationError(
        `CloudEvent field '${field}' is mandatory and cannot be OMIT.`,
      );
    }
  }
}

/** Rejects custom attribute keys CloudEvents or the reserved set forbid. */
function validateCustomAttributes(
  custom: Record<string, AttributeBinding> | undefined,
): void {
  for (const key of Object.keys(custom ?? {})) {
    if ((RESERVED_ATTRIBUTES as readonly string[]).includes(key)) {
      throw new InputValidationError(
        `Custom attribute '${key}' shadows a standard CloudEvent attribute.`,
      );
    }
    if (!LOWERCASE_ALPHANUMERIC_PATTERN.test(key)) {
      throw new InputValidationError(
        `Custom attribute '${key}' is invalid. CloudEvent attributes MUST ` +
          "consist of lower-case letters ('a' to 'z') or digits ('0' to '9').",
      );
    }
  }
}

/** Every attribute key the model has to supply, with its binding. */
function agentProvidedKeys(
  bus: AttributeBinding,
  binding: CloudEventAttributesBinding,
): Array<[string, AgentProvided]> {
  const found: Array<[string, AgentProvided]> = [];
  if (bus instanceof AgentProvided) {
    found.push(['bus', bus]);
  }
  for (const field of RESERVED_ATTRIBUTES) {
    const value = binding[field];
    if (value instanceof AgentProvided) {
      found.push([field, value]);
    }
  }
  for (const [key, value] of Object.entries(binding.customAttributes ?? {})) {
    if (value instanceof AgentProvided) {
      found.push([key, value]);
    }
  }
  return found;
}

/**
 * Builds the schema the model fills in: one string per agent-provided
 * attribute, plus `event_data` when the tool declares a payload.
 */
function buildParameters(
  provided: Array<[string, AgentProvided]>,
  payloadSchema?: z.ZodType,
): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, agentProvided] of provided) {
    const field = z.string().describe(agentProvided.description);
    shape[key] = agentProvided.default === undefined ? field : field.optional();
  }
  if (payloadSchema !== undefined) {
    shape[PAYLOAD_PARAMETER] = payloadSchema;
  }
  return z.object(shape);
}

/**
 * Reduces one binding to the value it publishes.
 *
 * An `AgentProvided` attribute with no default is a required parameter of the
 * generated schema, so the tool rejects a call that leaves it out before this
 * runs. adk-python needs its own guard here because it synthesises a Python
 * signature instead.
 *
 * @return The value, `OMIT` to leave the attribute off, or `undefined` when
 *   the binding is not configured.
 */
function resolveBinding(
  key: string,
  binding: AttributeBinding | undefined,
  args: Record<string, unknown>,
  payload: unknown,
  toolContext?: Context,
): string | typeof OMIT | undefined {
  if (binding === undefined) {
    return undefined;
  }
  let value:
    | string
    | typeof OMIT
    | AttributeResolver<string | typeof OMIT>
    | undefined;
  if (binding instanceof AgentProvided) {
    const supplied = args[key];
    value = typeof supplied === 'string' ? supplied : binding.default;
  } else {
    value = binding;
  }
  return isResolver(value) ? value(payload, toolContext) : value;
}

/**
 * Resolves every reserved attribute into the arguments `publishMessage` takes.
 *
 * @throws {InputValidationError} If a mandatory attribute resolves to `OMIT`.
 */
function resolveReservedAttributes(
  binding: CloudEventAttributesBinding,
  args: Record<string, unknown>,
  payload: unknown,
  toolContext?: Context,
): Map<ReservedAttribute, string> {
  const resolved = new Map<ReservedAttribute, string>();
  for (const field of RESERVED_ATTRIBUTES) {
    const value = resolveBinding(
      field,
      binding[field],
      args,
      payload,
      toolContext,
    );
    if (value === OMIT) {
      if (MANDATORY_ATTRIBUTES.includes(field)) {
        throw new InputValidationError(
          `Mandatory CloudEvent attribute '${field}' cannot evaluate to OMIT.`,
        );
      }
      if (NON_OMITTABLE_ATTRIBUTES.includes(field)) {
        throw new InputValidationError(
          `CloudEvent attribute '${field}' is mandatory and cannot be OMIT.`,
        );
      }
      if (EMPTY_STRING_OMITS.includes(field)) {
        resolved.set(field, '');
      }
    } else if (value !== undefined) {
      resolved.set(field, value);
    }
  }
  return resolved;
}

/** Resolves the custom attributes the event carries. */
function resolveCustomAttributes(
  custom: Record<string, AttributeBinding> | undefined,
  args: Record<string, unknown>,
  payload: unknown,
  toolContext?: Context,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, binding] of Object.entries(custom ?? {})) {
    const value = resolveBinding(key, binding, args, payload, toolContext);
    if (value !== OMIT && value !== undefined) {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Resolves every binding and publishes the resulting CloudEvent.
 *
 * @throws {InputValidationError} If `bus` resolves to nothing, a mandatory
 *   attribute resolves to `OMIT`, or the model omitted a required value.
 */
function executeDomainSpecificPublish(
  bus: AttributeBinding,
  binding: CloudEventAttributesBinding,
  options: DomainSpecificToolOptions,
  args: Record<string, unknown>,
  toolContext?: Context,
): Promise<PublishMessageResult> {
  const payload = args[PAYLOAD_PARAMETER];

  const busValue = resolveBinding('bus', bus, args, payload, toolContext);
  if (busValue === OMIT || busValue === undefined) {
    throw new InputValidationError(
      "Mandatory attribute 'bus' cannot evaluate to None or OMIT.",
    );
  }

  const reserved = resolveReservedAttributes(
    binding,
    args,
    payload,
    toolContext,
  );
  const custom = resolveCustomAttributes(
    binding.customAttributes,
    args,
    payload,
    toolContext,
  );

  const input: PublishMessageInput = {
    bus: busValue,
    type: reserved.get('type') ?? '',
    source: reserved.get('source') ?? '',
  };
  for (const field of ['datacontenttype', 'subject', 'specversion'] as const) {
    const value = reserved.get(field);
    if (value !== undefined) {
      input[field] = value;
    }
  }
  if (reserved.has('id')) {
    input.id = reserved.get('id');
  }
  if (reserved.has('time')) {
    input.time = reserved.get('time');
  }
  if (Object.keys(custom).length > 0) {
    input.custom_attributes = custom;
  }
  if (payload !== undefined) {
    input.data = payload;
  }

  return publishMessage(input, options);
}

/**
 * Builds a publish tool with its CloudEvent attributes bound in advance.
 *
 * Every binding is validated here, so a misconfigured tool fails when the
 * application starts rather than when the model first calls it.
 *
 * @param toolOptions What to bind and what to ask the model for.
 * @param options The credentials and settings the toolset supplies.
 * @return The tool, ready to add to a toolset.
 * @throws {InputValidationError} If any binding is invalid.
 */
export function buildDomainSpecificTool(
  toolOptions: CreatePublishToolOptions,
  options: DomainSpecificToolOptions = {},
): FunctionTool<z.ZodObject<z.ZodRawShape>> {
  const {name, description, bus, ceAttributesBinding, payloadSchema} =
    toolOptions;

  validateBus(bus);
  validateReservedAttributes(ceAttributesBinding);
  validateCustomAttributes(ceAttributesBinding.customAttributes);

  const parameters = buildParameters(
    agentProvidedKeys(bus, ceAttributesBinding),
    payloadSchema,
  );

  return new FunctionTool({
    name,
    description,
    parameters,
    execute: (input, toolContext) =>
      executeDomainSpecificPublish(
        bus,
        ceAttributesBinding,
        options,
        input,
        toolContext,
      ),
  });
}
