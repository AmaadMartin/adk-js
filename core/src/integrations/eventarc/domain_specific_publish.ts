/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';

import {BaseTool} from '../../tools/base_tool.js';
import {FunctionTool, ToolInputParameters} from '../../tools/function_tool.js';
import {
  isZodObject,
  zodObjectToSchema,
} from '../../utils/simple_zod_to_json.js';
import {EventarcCredentialsConfig, EventarcToolConfig} from './config.js';
import {
  publishMessage,
  PublishMessageOptions,
  PublishMessageResult,
} from './message_tool.js';

/**
 * Marks a binding as "not specified by the toolset author", which is
 * equivalent to leaving the field out entirely.
 *
 * Registered through `Symbol.for` so that two copies of `@google/adk` in one
 * runtime agree on sentinel identity.
 */
export const MISSING: unique symbol = Symbol.for('google.adk.eventarc.MISSING');

/** Type of the {@link MISSING} sentinel. */
export type MissingSentinel = typeof MISSING;

/** Marks a binding as "drop this attribute from the emitted CloudEvent". */
export const OMIT: unique symbol = Symbol.for('google.adk.eventarc.OMIT');

/** Type of the {@link OMIT} sentinel. */
export type OmitSentinel = typeof OMIT;

/**
 * Brands the objects {@link AgentProvided} returns, following the signature
 * symbol pattern used by `BaseTool`, so that two copies of `@google/adk` in one
 * runtime still recognise each other's bindings.
 */
const AGENT_PROVIDED_SIGNATURE_SYMBOL: unique symbol = Symbol.for(
  'google.adk.eventarc.agentProvided',
);

/** Fallback used when the model omits an {@link AgentProvided} attribute. */
export type AgentProvidedDefault<TPayload = unknown> =
  | string
  | ((payload: TPayload) => string | OmitSentinel)
  | OmitSentinel
  | MissingSentinel
  | null;

/**
 * A CloudEvent attribute supplied by the model at call time, as produced by
 * {@link AgentProvided}.
 */
export interface AgentProvidedBinding<TPayload = unknown> {
  readonly [AGENT_PROVIDED_SIGNATURE_SYMBOL]: true;
  /** Description shown to the model for this parameter. */
  readonly description: string;
  /** Fallback used when the model omits the parameter. */
  readonly default?: AgentProvidedDefault<TPayload>;
}

/**
 * Declares a CloudEvent attribute that the model fills in.
 *
 * Without a `default` the attribute becomes a required tool parameter; with
 * one it becomes optional.
 */
export function AgentProvided<TPayload = unknown>(options: {
  description: string;
  default?: AgentProvidedDefault<TPayload>;
}): AgentProvidedBinding<TPayload> {
  return {
    [AGENT_PROVIDED_SIGNATURE_SYMBOL]: true,
    description: options.description,
    default: options.default,
  };
}

/** Returns true when the value was produced by {@link AgentProvided}. */
export function isAgentProvided<TPayload = unknown>(
  value: unknown,
): value is AgentProvidedBinding<TPayload> {
  return (
    typeof value === 'object' &&
    value !== null &&
    AGENT_PROVIDED_SIGNATURE_SYMBOL in value &&
    value[AGENT_PROVIDED_SIGNATURE_SYMBOL] === true
  );
}

/** Computes an attribute value from the tool payload. */
export type AttributeResolver<TPayload> = (payload: TPayload) => string;

/** A mandatory attribute: fixed string, payload-derived, or model-supplied. */
export type AttributeBinding<TPayload = unknown> =
  | string
  | AttributeResolver<TPayload>
  | AgentProvidedBinding<TPayload>;

/** An optional attribute; may additionally be omitted or left unspecified. */
export type OptionalAttributeBinding<TPayload = unknown> =
  | string
  | ((payload: TPayload) => string | OmitSentinel)
  | AgentProvidedBinding<TPayload>
  | OmitSentinel
  | MissingSentinel
  | null;

/** A custom (extension) attribute. {@link MISSING} is rejected at build time. */
export type CustomAttributeBinding<TPayload = unknown> =
  | string
  | ((payload: TPayload) => string | OmitSentinel)
  | AgentProvidedBinding<TPayload>
  | OmitSentinel;

/** Binds each CloudEvent attribute to a value, a resolver, or a sentinel. */
export interface CloudEventAttributesBinding<TPayload = unknown> {
  type: AttributeBinding<TPayload>;
  source: AttributeBinding<TPayload>;
  datacontenttype?: OptionalAttributeBinding<TPayload>;
  subject?: OptionalAttributeBinding<TPayload>;
  time?: OptionalAttributeBinding<TPayload>;
  specversion?: OptionalAttributeBinding<TPayload>;
  id?: OptionalAttributeBinding<TPayload>;
  /** Extension attributes, keyed by their lower-case alphanumeric name. */
  customAttributes?: Record<string, CustomAttributeBinding<TPayload>>;
}

/** Arguments accepted by {@link buildDomainSpecificTool}. */
export interface DomainSpecificToolOptions<TPayload = unknown> {
  /** Tool name exposed to the model. */
  name: string;
  /** Prompt-friendly description of what the tool publishes. */
  description: string;
  /** Message bus resource name, or a binding that resolves to one. */
  bus: AttributeBinding<TPayload>;
  /** Bindings for the CloudEvent attributes. */
  ceAttributesBinding: CloudEventAttributesBinding<TPayload>;
  /** Schema of the structured payload exposed as `event_data`. */
  payloadSchema?: ToolInputParameters;
  toolConfig?: EventarcToolConfig;
  credentialsConfig?: EventarcCredentialsConfig;
}

/** Attributes that must always resolve to a value. */
const MANDATORY_ATTRIBUTES = ['type', 'source'] as const;

/** Attributes that are dropped from the event when they resolve to nothing. */
const OPTIONAL_ATTRIBUTES = [
  'datacontenttype',
  'subject',
  'time',
  'specversion',
  'id',
] as const;

/**
 * CloudEvent attributes that extension attributes may not shadow, in the fixed
 * order used to generate the tool declaration.
 */
const RESERVED_ATTRIBUTES = [
  ...MANDATORY_ATTRIBUTES,
  ...OPTIONAL_ATTRIBUTES,
] as const;

type ReservedAttribute = (typeof RESERVED_ATTRIBUTES)[number];

/** Model-facing parameter carrying the structured payload. */
const EVENT_DATA_PARAMETER = 'event_data';

const CUSTOM_ATTRIBUTE_KEY_PATTERN = /^[a-z0-9]+$/;

/**
 * Builds a tool that publishes a CloudEvent whose attributes are fixed by the
 * toolset author, derived from the payload, or supplied by the model.
 *
 * @throws When the bindings are inconsistent, e.g. a mandatory attribute bound
 *     to {@link OMIT} or an extension attribute with an illegal name.
 */
export function buildDomainSpecificTool<TPayload = unknown>(
  options: DomainSpecificToolOptions<TPayload>,
): BaseTool {
  const {bus, ceAttributesBinding, payloadSchema} = options;
  validateBindings(bus, ceAttributesBinding);

  return new FunctionTool({
    name: options.name,
    description: options.description,
    parameters: buildParameters(bus, ceAttributesBinding, payloadSchema),
    async execute(input: unknown): Promise<PublishMessageResult> {
      const args = isRecord(input) ? input : {};
      const payload = parsePayload<TPayload>(
        payloadSchema,
        args[EVENT_DATA_PARAMETER],
      );

      const publishOptions: PublishMessageOptions = {
        toolConfig: options.toolConfig,
        credentialsConfig: options.credentialsConfig,
        bus: resolveBus(bus, args, payload),
        type: resolveMandatory('type', ceAttributesBinding.type, args, payload),
        source: resolveMandatory(
          'source',
          ceAttributesBinding.source,
          args,
          payload,
        ),
      };
      if (payloadSchema !== undefined) {
        publishOptions.data = payload;
      }

      for (const attribute of OPTIONAL_ATTRIBUTES) {
        const value = resolveAttribute({
          key: attribute,
          binding: ceAttributesBinding[attribute],
          mandatory: false,
          args,
          payload,
        });
        if (value !== undefined) {
          publishOptions[attribute] = value;
        }
      }

      const customAttributes = resolveCustomAttributes(
        ceAttributesBinding.customAttributes,
        args,
        payload,
      );
      if (Object.keys(customAttributes).length > 0) {
        publishOptions.customAttributes = customAttributes;
      }

      return publishMessage(publishOptions);
    },
  });
}

function validateBindings<TPayload>(
  bus: AttributeBinding<TPayload>,
  ceAttributesBinding: CloudEventAttributesBinding<TPayload>,
): void {
  for (const field of MANDATORY_ATTRIBUTES) {
    assertMandatoryBinding(ceAttributesBinding[field], {
      missing: `CloudEventAttributesBinding requires '${field}' to be provided.`,
      omit: `CloudEvent field '${field}' is mandatory and cannot be OMIT.`,
      nullish: `CloudEvent field '${field}' is mandatory and cannot be null or undefined.`,
    });
  }

  assertMandatoryBinding(bus, {
    missing: "The 'bus' parameter is mandatory and must be provided.",
    omit: "The 'bus' parameter is mandatory and cannot be OMIT.",
    nullish:
      "The 'bus' parameter is mandatory and cannot be null or undefined.",
  });

  for (const [key, binding] of Object.entries<unknown>(
    ceAttributesBinding.customAttributes ?? {},
  )) {
    if (isReservedAttribute(key)) {
      throw new Error(
        `Custom attribute '${key}' shadows a standard CloudEvent attribute.`,
      );
    }
    if (!CUSTOM_ATTRIBUTE_KEY_PATTERN.test(key)) {
      throw new Error(
        `Custom attribute '${key}' is invalid. CloudEvent attributes MUST ` +
          "consist of lower-case letters ('a' to 'z') or digits ('0' to '9').",
      );
    }
    if (binding === MISSING) {
      throw new TypeError(`Custom attribute '${key}' cannot be MISSING.`);
    }
  }
}

/**
 * Rejects a binding that cannot produce a value for a mandatory field.
 *
 * The binding is typed as `unknown` because the sentinels are deliberately
 * absent from the mandatory binding types: TypeScript already rejects them,
 * and this guard covers untyped JavaScript callers.
 */
function assertMandatoryBinding(
  binding: unknown,
  errors: {missing: string; omit: string; nullish: string},
): void {
  if (binding === MISSING || binding === undefined) {
    throw new TypeError(errors.missing);
  }
  if (binding === OMIT) {
    throw new TypeError(errors.omit);
  }
  if (binding === null) {
    throw new TypeError(errors.nullish);
  }
}

function buildParameters<TPayload>(
  bus: AttributeBinding<TPayload>,
  ceAttributesBinding: CloudEventAttributesBinding<TPayload>,
  payloadSchema: ToolInputParameters,
): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];

  const declare = (key: string, binding: unknown): void => {
    if (!isAgentProvided(binding)) {
      return;
    }
    properties[key] = agentProvidedSchema(binding);
    if (isRequiredParameter(binding)) {
      required.push(key);
    }
  };

  declare('bus', bus);
  for (const attribute of RESERVED_ATTRIBUTES) {
    declare(attribute, ceAttributesBinding[attribute]);
  }
  for (const [key, binding] of Object.entries(
    ceAttributesBinding.customAttributes ?? {},
  )) {
    declare(key, binding);
  }

  if (payloadSchema !== undefined) {
    properties[EVENT_DATA_PARAMETER] = isZodObject(payloadSchema)
      ? zodObjectToSchema(payloadSchema)
      : payloadSchema;
    required.push(EVENT_DATA_PARAMETER);
  }

  return {type: Type.OBJECT, properties, required};
}

/**
 * A model parameter is required exactly when the author declared no fallback.
 * Callable, {@link OMIT} and `null` defaults are not surfaced to the model
 * because they can only be evaluated at call time.
 */
function isRequiredParameter(binding: AgentProvidedBinding): boolean {
  return binding.default === undefined || binding.default === MISSING;
}

function agentProvidedSchema(binding: AgentProvidedBinding): Schema {
  const schema: Schema = {
    type: Type.STRING,
    description: binding.description,
  };
  if (typeof binding.default === 'string') {
    schema.default = binding.default;
  }
  return schema;
}

function resolveBus<TPayload>(
  bus: AttributeBinding<TPayload>,
  args: Record<string, unknown>,
  payload: TPayload,
): string {
  const value = resolveAttribute({
    key: 'bus',
    binding: bus,
    mandatory: true,
    args,
    payload,
  });
  if (value === undefined) {
    throw new Error(
      "Mandatory attribute 'bus' cannot evaluate to None or OMIT.",
    );
  }
  return value;
}

function resolveMandatory<TPayload>(
  key: (typeof MANDATORY_ATTRIBUTES)[number],
  binding: AttributeBinding<TPayload>,
  args: Record<string, unknown>,
  payload: TPayload,
): string {
  const value = resolveAttribute({
    key,
    binding,
    mandatory: true,
    args,
    payload,
  });
  if (value === undefined) {
    throw new Error(
      `Mandatory CloudEvent attribute '${key}' cannot evaluate to null or undefined.`,
    );
  }
  return value;
}

function resolveCustomAttributes<TPayload>(
  customAttributes:
    | Record<string, CustomAttributeBinding<TPayload>>
    | undefined,
  args: Record<string, unknown>,
  payload: TPayload,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, binding] of Object.entries(customAttributes ?? {})) {
    const value = resolveAttribute({
      key,
      binding,
      mandatory: false,
      args,
      payload,
    });
    if (value !== undefined) {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Resolves one attribute binding against the model arguments and the payload.
 *
 * @returns The attribute value, or `undefined` when the attribute must not be
 *     emitted.
 */
function resolveAttribute<TPayload>(options: {
  key: string;
  binding:
    | OptionalAttributeBinding<TPayload>
    | AttributeBinding<TPayload>
    | undefined;
  mandatory: boolean;
  args: Record<string, unknown>;
  payload: TPayload;
}): string | undefined {
  const {key, binding, mandatory, args, payload} = options;

  if (binding === MISSING || binding === undefined) {
    return undefined;
  }

  let value:
    | string
    | ((payload: TPayload) => string | OmitSentinel)
    | OmitSentinel
    | MissingSentinel
    | null;

  if (isAgentProvided<TPayload>(binding)) {
    const supplied = args[key];
    if (supplied !== undefined && supplied !== null) {
      return String(supplied);
    }
    if (binding.default === undefined || binding.default === MISSING) {
      throw new Error(`Agent did not provide mandatory attribute '${key}'`);
    }
    value = binding.default;
  } else {
    value = binding;
  }

  if (typeof value === 'function') {
    value = value(payload);
  }

  if (value === OMIT) {
    if (mandatory) {
      throw new Error(
        `Mandatory CloudEvent attribute '${key}' cannot evaluate to OMIT.`,
      );
    }
    return undefined;
  }

  return value === null ? undefined : value;
}

/**
 * Validates the structured payload against `payloadSchema` when it is a zod
 * object. The result carries the caller-declared `TPayload` contract that the
 * binding callbacks are typed against.
 */
function parsePayload<TPayload>(
  payloadSchema: ToolInputParameters,
  value: unknown,
): TPayload {
  const parsed = isZodObject(payloadSchema)
    ? payloadSchema.parse(value)
    : value;
  return parsed as TPayload;
}

function isReservedAttribute(key: string): key is ReservedAttribute {
  return RESERVED_ATTRIBUTES.some((attribute) => attribute === key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
