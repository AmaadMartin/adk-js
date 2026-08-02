/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {
  AgentProvided,
  buildDomainSpecificTool,
  CloudEventAttributesBinding,
  DomainSpecificToolOptions,
  isAgentProvided,
  MISSING,
  OMIT,
} from '../../../src/integrations/eventarc/domain_specific_publish.js';
import {
  publishMessage,
  PublishMessageOptions,
} from '../../../src/integrations/eventarc/message_tool.js';
import {createToolContext} from './eventarc_test_utils.js';

vi.mock(
  '../../../src/integrations/eventarc/message_tool.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../src/integrations/eventarc/message_tool.js')
      >();
    return {
      ...actual,
      publishMessage: vi.fn(async () => ({
        status: 'SUCCESS' as const,
        message_id: 'generated-id',
      })),
    };
  },
);

interface OrderPayload {
  userId: string;
  action: string;
}

const ORDER_PAYLOAD_SCHEMA = z.object({
  userId: z.string(),
  action: z.string(),
});

const TOOL_CONTEXT = createToolContext();

function buildTool<TPayload = unknown>(
  options: Partial<DomainSpecificToolOptions<TPayload>> & {
    ceAttributesBinding: CloudEventAttributesBinding<TPayload>;
  },
) {
  return buildDomainSpecificTool<TPayload>({
    name: 'publish_order_event',
    description: 'Publishes an order lifecycle event.',
    bus: 'projects/p/locations/l/messageBuses/orders',
    ...options,
  });
}

/**
 * Builds tool options the way an untyped JavaScript caller can.
 *
 * TypeScript rejects a sentinel, `null` or `undefined` on `bus`, `type` and
 * `source`, so the build-time guards that defend those fields can only be
 * reached through a loosely typed object.
 */
function buildToolFromJs(overrides: Record<string, unknown>) {
  const options: DomainSpecificToolOptions = {
    name: 'publish_order_event',
    description: 'Publishes an order lifecycle event.',
    bus: 'projects/p/locations/l/messageBuses/orders',
    ceAttributesBinding: {type: 'my-type', source: 'my-source'},
  };
  for (const [key, value] of Object.entries(overrides)) {
    Reflect.set(options, key, value);
  }
  return buildDomainSpecificTool(options);
}

/** Builds tool options whose CloudEvent bindings come from untyped JavaScript. */
function buildToolFromJsBindings(overrides: Record<string, unknown>) {
  const ceAttributesBinding: CloudEventAttributesBinding = {
    type: 'my-type',
    source: 'my-source',
  };
  for (const [key, value] of Object.entries(overrides)) {
    Reflect.set(ceAttributesBinding, key, value);
  }
  return buildToolFromJs({ceAttributesBinding});
}

function lastPublishOptions(): PublishMessageOptions {
  const call = vi.mocked(publishMessage).mock.calls.at(-1);
  if (!call) {
    expect.fail('publishMessage was not called');
  }
  return call[0];
}

function declaredParameters(schema: Schema | undefined): Schema {
  if (!schema) {
    expect.fail('the tool declaration has no parameters');
  }
  return schema;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentProvided', () => {
  it('brands its result so isAgentProvided recognises it', () => {
    expect(isAgentProvided(AgentProvided({description: 'The type.'}))).toBe(
      true,
    );
  });

  it('rejects values that are not agent-provided bindings', () => {
    expect(isAgentProvided('literal')).toBe(false);
    expect(isAgentProvided(null)).toBe(false);
    expect(isAgentProvided({description: 'not branded'})).toBe(false);
  });

  it('keeps MISSING and OMIT distinct', () => {
    expect(MISSING).not.toBe(OMIT);
    expect(MISSING).toBe(Symbol.for('google.adk.eventarc.MISSING'));
    expect(OMIT).toBe(Symbol.for('google.adk.eventarc.OMIT'));
  });
});

describe('buildDomainSpecificTool build-time validation', () => {
  it('rejects a MISSING bus', () => {
    expect(() => buildToolFromJs({bus: MISSING})).toThrow(
      "The 'bus' parameter is mandatory and must be provided.",
    );
  });

  it('rejects an undefined bus', () => {
    expect(() => buildToolFromJs({bus: undefined})).toThrow(
      "The 'bus' parameter is mandatory and must be provided.",
    );
  });

  it('rejects an OMIT bus', () => {
    expect(() => buildToolFromJs({bus: OMIT})).toThrow(
      "The 'bus' parameter is mandatory and cannot be OMIT.",
    );
  });

  it('rejects a null bus', () => {
    expect(() => buildToolFromJs({bus: null})).toThrow(
      "The 'bus' parameter is mandatory and cannot be null or undefined.",
    );
  });

  it('rejects a missing mandatory attribute', () => {
    expect(() => buildToolFromJsBindings({type: MISSING})).toThrow(
      "CloudEventAttributesBinding requires 'type' to be provided.",
    );
    expect(() => buildToolFromJsBindings({source: undefined})).toThrow(
      "CloudEventAttributesBinding requires 'source' to be provided.",
    );
  });

  it('rejects an OMIT mandatory attribute', () => {
    expect(() => buildToolFromJsBindings({type: OMIT})).toThrow(
      "CloudEvent field 'type' is mandatory and cannot be OMIT.",
    );
  });

  it('rejects a null mandatory attribute', () => {
    expect(() => buildToolFromJsBindings({type: null})).toThrow(
      "CloudEvent field 'type' is mandatory and cannot be null or undefined.",
    );
  });

  it.each(['self_', 'my-key', 'MyKey', 'event_data'])(
    'rejects the invalid custom attribute key %s',
    (key) => {
      expect(() =>
        buildTool({
          ceAttributesBinding: {
            type: 'my-type',
            source: 'my-source',
            customAttributes: {[key]: AgentProvided({description: 'desc'})},
          },
        }),
      ).toThrow(`Custom attribute '${key}' is invalid`);
    },
  );

  it.each([
    'type',
    'source',
    'datacontenttype',
    'subject',
    'time',
    'specversion',
    'id',
  ])(
    'rejects the custom attribute %s that shadows a standard attribute',
    (key) => {
      expect(() =>
        buildTool({
          ceAttributesBinding: {
            type: 'my-type',
            source: 'my-source',
            customAttributes: {[key]: 'value'},
          },
        }),
      ).toThrow(
        `Custom attribute '${key}' shadows a standard CloudEvent attribute.`,
      );
    },
  );

  it('rejects a MISSING custom attribute', () => {
    expect(() =>
      buildToolFromJsBindings({customAttributes: {mykey: MISSING}}),
    ).toThrow("Custom attribute 'mykey' cannot be MISSING.");
  });
});

describe('buildDomainSpecificTool declaration', () => {
  it('exposes only the agent-provided attributes and the payload', () => {
    const tool = buildTool<OrderPayload>({
      ceAttributesBinding: {
        type: AgentProvided({description: 'The type'}),
        source: AgentProvided({
          description: 'The source',
          default: 'default-source',
        }),
        subject: AgentProvided({
          description: 'The subject',
          default: () => 'dyn-subject',
        }),
        time: AgentProvided({description: 'The time', default: OMIT}),
        datacontenttype: 'application/json',
        id: (payload) => payload.userId,
      },
      payloadSchema: ORDER_PAYLOAD_SCHEMA,
    });

    const parameters = declaredParameters(tool._getDeclaration()?.parameters);

    expect(Object.keys(parameters.properties ?? {})).toEqual([
      'type',
      'source',
      'subject',
      'time',
      'event_data',
    ]);
    expect(parameters.required).toEqual(['type', 'event_data']);
    expect(parameters.properties?.['type']).toEqual({
      type: Type.STRING,
      description: 'The type',
    });
    expect(parameters.properties?.['source']).toEqual({
      type: Type.STRING,
      description: 'The source',
      default: 'default-source',
    });
    expect(parameters.properties?.['subject']).not.toHaveProperty('default');
    expect(parameters.properties?.['time']).not.toHaveProperty('default');
    expect(parameters.properties?.['event_data']).toMatchObject({
      type: Type.OBJECT,
    });
  });

  it('keeps MISSING and OMIT defaults from collapsing into each other', () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: AgentProvided({description: 'The type'}),
        source: AgentProvided({description: 'The source', default: MISSING}),
        subject: AgentProvided({description: 'The subject', default: OMIT}),
        time: AgentProvided({description: 'The time', default: null}),
      },
    });

    const parameters = declaredParameters(tool._getDeclaration()?.parameters);

    expect(parameters.required).toEqual(['type', 'source']);
    expect(Object.keys(parameters.properties ?? {})).toContain('subject');
    expect(Object.keys(parameters.properties ?? {})).toContain('time');
  });

  it('omits event_data when there is no payload schema', () => {
    const tool = buildTool({
      ceAttributesBinding: {type: 'my-type', source: 'my-source'},
    });

    const parameters = declaredParameters(tool._getDeclaration()?.parameters);

    expect(parameters.properties).toEqual({});
    expect(parameters.required).toEqual([]);
  });

  it('exposes an agent-provided bus and a raw payload schema unchanged', () => {
    const rawSchema: Schema = {
      type: Type.OBJECT,
      properties: {orderId: {type: Type.STRING}},
    };
    const tool = buildTool({
      bus: AgentProvided({description: 'The bus'}),
      ceAttributesBinding: {type: 'my-type', source: 'my-source'},
      payloadSchema: rawSchema,
    });

    const parameters = declaredParameters(tool._getDeclaration()?.parameters);

    expect(parameters.properties?.['bus']).toEqual({
      type: Type.STRING,
      description: 'The bus',
    });
    expect(parameters.properties?.['event_data']).toBe(rawSchema);
    expect(parameters.required).toEqual(['bus', 'event_data']);
  });

  it('leaves custom attribute names unmangled in the declaration', () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: 'my-type',
        source: 'my-source',
        customAttributes: {
          self: AgentProvided({description: 'desc'}),
          cls: AgentProvided({description: 'desc'}),
          '123foo': AgentProvided({description: 'desc'}),
        },
      },
    });

    const parameters = declaredParameters(tool._getDeclaration()?.parameters);

    expect(Object.keys(parameters.properties ?? {})).toEqual([
      'self',
      'cls',
      '123foo',
    ]);
  });
});

describe('buildDomainSpecificTool runtime resolution', () => {
  it('resolves fixed, payload-derived and agent-provided attributes', async () => {
    const tool = buildTool<OrderPayload>({
      ceAttributesBinding: {
        type: (payload) => `action.${payload.action}`,
        source: 'my-source',
        subject: AgentProvided({
          description: 'Subject',
          default: (payload) => payload.userId,
        }),
        time: OMIT,
      },
      payloadSchema: ORDER_PAYLOAD_SCHEMA,
    });

    await tool.runAsync({
      args: {event_data: {userId: 'user123', action: 'login'}},
      toolContext: TOOL_CONTEXT,
    });

    const options = lastPublishOptions();
    expect(options.bus).toBe('projects/p/locations/l/messageBuses/orders');
    expect(options.type).toBe('action.login');
    expect(options.source).toBe('my-source');
    expect(options.subject).toBe('user123');
    expect(options).not.toHaveProperty('time');
    expect(options.data).toEqual({userId: 'user123', action: 'login'});
  });

  it('falls back to the declared default when the model sends null', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: 'my-type',
        source: 'my-source',
        subject: AgentProvided({
          description: 'Subject',
          default: 'fallback-subject',
        }),
      },
    });

    await tool.runAsync({args: {subject: null}, toolContext: TOOL_CONTEXT});

    expect(lastPublishOptions().subject).toBe('fallback-subject');
  });

  it('prefers the model value over the declared default', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: 'my-type',
        source: 'my-source',
        subject: AgentProvided({
          description: 'Subject',
          default: 'fallback-subject',
        }),
      },
    });

    await tool.runAsync({
      args: {subject: 'model-subject'},
      toolContext: TOOL_CONTEXT,
    });

    expect(lastPublishOptions().subject).toBe('model-subject');
  });

  it('drops an OMIT default while requiring an attribute without one', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: AgentProvided({description: 'The type'}),
        source: 'my-source',
        subject: AgentProvided({description: 'The subject', default: OMIT}),
      },
    });

    await expect(
      tool.runAsync({args: {}, toolContext: TOOL_CONTEXT}),
    ).rejects.toThrow("Agent did not provide mandatory attribute 'type'");

    await tool.runAsync({
      args: {type: 'model-type'},
      toolContext: TOOL_CONTEXT,
    });

    const options = lastPublishOptions();
    expect(options.type).toBe('model-type');
    expect(options).not.toHaveProperty('subject');
  });

  it('rejects a mandatory attribute that resolves to OMIT', async () => {
    const tool = buildToolFromJsBindings({type: () => OMIT});

    await expect(
      tool.runAsync({args: {}, toolContext: TOOL_CONTEXT}),
    ).rejects.toThrow(
      "Mandatory CloudEvent attribute 'type' cannot evaluate to OMIT.",
    );
  });

  it('rejects a mandatory attribute that resolves to null', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: AgentProvided({description: 'The type', default: null}),
        source: 'my-source',
      },
    });

    await expect(
      tool.runAsync({args: {}, toolContext: TOOL_CONTEXT}),
    ).rejects.toThrow(
      "Mandatory CloudEvent attribute 'type' cannot evaluate to null or undefined.",
    );
  });

  it('rejects a bus the model did not provide', async () => {
    const tool = buildTool({
      bus: AgentProvided({description: 'The bus'}),
      ceAttributesBinding: {type: 'my-type', source: 'my-source'},
    });

    await expect(
      tool.runAsync({args: {}, toolContext: TOOL_CONTEXT}),
    ).rejects.toThrow("Agent did not provide mandatory attribute 'bus'");
  });

  it('rejects a bus that resolves to OMIT', async () => {
    const tool = buildTool({
      bus: AgentProvided({description: 'The bus', default: OMIT}),
      ceAttributesBinding: {type: 'my-type', source: 'my-source'},
    });

    await expect(
      tool.runAsync({args: {}, toolContext: TOOL_CONTEXT}),
    ).rejects.toThrow(
      "Mandatory CloudEvent attribute 'bus' cannot evaluate to OMIT.",
    );
  });

  it('rejects a bus that resolves to null', async () => {
    const tool = buildTool({
      bus: AgentProvided({description: 'The bus', default: null}),
      ceAttributesBinding: {type: 'my-type', source: 'my-source'},
    });

    await expect(
      tool.runAsync({args: {}, toolContext: TOOL_CONTEXT}),
    ).rejects.toThrow(
      "Mandatory attribute 'bus' cannot evaluate to None or OMIT.",
    );
  });

  it('drops optional attributes bound to null or MISSING', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: 'my-type',
        source: 'my-source',
        time: null,
        subject: null,
        id: MISSING,
        specversion: () => OMIT,
      },
    });

    await tool.runAsync({args: {}, toolContext: TOOL_CONTEXT});

    const options = lastPublishOptions();
    expect(options).not.toHaveProperty('time');
    expect(options).not.toHaveProperty('subject');
    expect(options).not.toHaveProperty('id');
    expect(options).not.toHaveProperty('specversion');
    expect(options).not.toHaveProperty('data');
  });

  it('round-trips custom attribute names unmangled', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: 'my-type',
        source: 'my-source',
        customAttributes: {
          self: AgentProvided({description: 'desc'}),
          cls: AgentProvided({description: 'desc'}),
          '123foo': AgentProvided({description: 'desc'}),
          region: 'europe',
          dropped: OMIT,
        },
      },
    });

    await tool.runAsync({
      args: {
        'self': 'self_value',
        'cls': 'cls_value',
        '123foo': 'foo_value',
      },
      toolContext: TOOL_CONTEXT,
    });

    expect(lastPublishOptions().customAttributes).toEqual({
      'self': 'self_value',
      'cls': 'cls_value',
      '123foo': 'foo_value',
      'region': 'europe',
    });
  });

  it('omits customAttributes entirely when every binding resolves to nothing', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: 'my-type',
        source: 'my-source',
        customAttributes: {dropped: OMIT},
      },
    });

    await tool.runAsync({args: {}, toolContext: TOOL_CONTEXT});

    expect(lastPublishOptions()).not.toHaveProperty('customAttributes');
  });

  it('validates the payload against the declared zod schema', async () => {
    const tool = buildTool<OrderPayload>({
      ceAttributesBinding: {type: 'my-type', source: 'my-source'},
      payloadSchema: ORDER_PAYLOAD_SCHEMA,
    });

    await expect(
      tool.runAsync({
        args: {event_data: {userId: 'user123'}},
        toolContext: TOOL_CONTEXT,
      }),
    ).rejects.toThrow(/Error in tool 'publish_order_event'/);
    expect(vi.mocked(publishMessage)).not.toHaveBeenCalled();
  });

  it('passes a raw-schema payload through without validation', async () => {
    const tool = buildTool({
      ceAttributesBinding: {type: 'my-type', source: 'my-source'},
      payloadSchema: {type: Type.OBJECT, properties: {}},
    });

    await tool.runAsync({
      args: {event_data: {anything: 1}},
      toolContext: TOOL_CONTEXT,
    });

    expect(lastPublishOptions().data).toEqual({anything: 1});
  });

  it('tolerates a non-object argument payload from the model', async () => {
    const tool = buildTool({
      ceAttributesBinding: {type: 'my-type', source: 'my-source'},
    });

    await tool.runAsync({args: {}, toolContext: TOOL_CONTEXT});

    expect(lastPublishOptions().type).toBe('my-type');
  });
});
