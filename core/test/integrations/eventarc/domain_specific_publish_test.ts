/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/eventarc/test_domain_specific_publish.py`,
 * read at `a3bd1115` on `main`. Each ported `it` keeps its Python name.
 *
 * The Python tests patch `publish_message` and assert on its keyword
 * arguments. These drive the real publish path against the shared fake
 * publisher client instead, and assert on the CloudEvent that reaches the
 * wire, which pins the same bindings one layer further down.
 *
 * Three Python tests have no counterpart.
 * `test_custom_attribute_missing_raises_typeerror` needs the `MISSING`
 * sentinel, which this port does not have, and
 * `test_runtime_execution_with_python_keywords` needs Python's identifier
 * renaming, which TypeScript object keys do not require. Replacements for
 * both are in `domain_specific_publish_adk_js_test.ts`.
 *
 * `test_mandatory_none_raises_typeerror` is the third. Python reports an
 * explicit `None` separately from an absent binding; this port reports both as
 * "not provided", so the assertion would be identical to
 * `test_mandatory_missing_raises_typeerror` below, which pins that message.
 */

import {
  AgentProvided,
  cleanupClients,
  EventarcPublishStatus,
  EventarcToolset,
  OMIT,
  type CloudEventAttributesBinding,
  type CreatePublishToolOptions,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  BUS,
  eventAttributes,
  onlyEvent,
  resetEventarcFake,
  SETTINGS,
  toolContext,
} from './eventarc_test_utils.js';

vi.mock('@google-cloud/eventarc-publishing', async () => {
  const {FakePublisherClient} = await import('./eventarc_test_utils.js');
  return {PublisherClient: FakePublisherClient};
});

/** The payload shape the Python tests call `DummyPayload`. */
const dummyPayload = z.object({user_id: z.string(), action: z.string()});

/** A toolset with the project id the Python fixture uses. */
function testToolset(): EventarcToolset {
  return new EventarcToolset({toolConfig: SETTINGS});
}

/** Builds a tool through the toolset, with the Python fixture's name. */
function buildTool(
  options: Partial<CreatePublishToolOptions> & {
    ceAttributesBinding: CloudEventAttributesBinding;
  },
) {
  return testToolset().createPublishTool({
    name: 'test_tool',
    description: 'desc',
    bus: BUS,
    ...options,
  });
}

/** Runs a tool and asserts it published successfully. */
async function runTool(
  tool: ReturnType<typeof buildTool>,
  args: Record<string, unknown> = {},
): Promise<void> {
  const result = await tool.runAsync({args, toolContext: toolContext()});
  expect(result).toMatchObject({status: EventarcPublishStatus.SUCCESS});
}

describe('buildDomainSpecificTool validation', () => {
  it('test_mandatory_missing_raises_typeerror', () => {
    expect(() =>
      buildTool({
        bus: undefined,
        ceAttributesBinding: {type: 'type', source: 'source'},
      }),
    ).toThrow("The 'bus' parameter is mandatory and must be provided.");
  });

  it('test_mandatory_omit_raises_typeerror', () => {
    expect(() =>
      buildTool({
        bus: OMIT,
        ceAttributesBinding: {type: 'type', source: 'source'},
      }),
    ).toThrow("The 'bus' parameter is mandatory and cannot be OMIT.");

    expect(() =>
      buildTool({ceAttributesBinding: {type: OMIT, source: 'source'}}),
    ).toThrow("CloudEvent field 'type' is mandatory and cannot be OMIT.");
  });

  it('test_invalid_cloudevent_attributes', () => {
    for (const key of ['self_', 'my-key', 'MyKey', 'event_data']) {
      expect(() =>
        buildTool({
          ceAttributesBinding: {
            type: 'my-type',
            source: 'my-source',
            customAttributes: {[key]: new AgentProvided({description: 'desc'})},
          },
        }),
      ).toThrow(`Custom attribute '${key}' is invalid`);
    }
  });

  it.each(['id', 'specversion'])(
    'test_id_and_specversion_omit_raise_typeerror (%s)',
    (field) => {
      expect(() =>
        buildTool({
          ceAttributesBinding: {
            type: 'my-type',
            source: 'my-source',
            [field]: OMIT,
          },
        }),
      ).toThrow(`CloudEvent field '${field}' is mandatory and cannot be OMIT.`);
    },
  );

  it('rejects a custom attribute shadowing a standard one', () => {
    expect(() =>
      buildTool({
        ceAttributesBinding: {
          type: 'my-type',
          source: 'my-source',
          customAttributes: {subject: 'x'},
        },
      }),
    ).toThrow("Custom attribute 'subject' shadows a standard CloudEvent");
  });
});

describe('buildDomainSpecificTool signature', () => {
  it('test_signature_generation', () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: new AgentProvided({description: 'The type'}),
        source: new AgentProvided({
          description: 'The source',
          default: 'default-source',
        }),
        time: new AgentProvided({description: 'The time', default: OMIT}),
      },
      payloadSchema: dummyPayload,
    });

    const declaration = tool._getDeclaration();
    const properties = declaration?.parameters?.properties ?? {};
    const required = declaration?.parameters?.required ?? [];

    expect(Object.keys(properties).sort()).toEqual([
      'event_data',
      'source',
      'time',
      'type',
    ]);
    expect(properties['type'].description).toBe('The type');
    expect(required).toContain('type');
    expect(required).not.toContain('source');
    expect(required).not.toContain('time');
  });

  it('test_no_payload_schema_omits_event_data', () => {
    const tool = buildTool({
      ceAttributesBinding: {type: 'my-type', source: 'my-source'},
    });

    const properties =
      tool._getDeclaration()?.parameters?.properties ?? undefined;
    expect(properties?.['event_data']).toBeUndefined();
  });
});

describe('buildDomainSpecificTool runtime', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
  });

  it('test_runtime_execution_with_payload', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: (payload) => `action.${(payload as {action: string}).action}`,
        source: 'my-source',
        subject: new AgentProvided({description: 'Subject', default: 'anon'}),
        time: OMIT,
      },
      payloadSchema: dummyPayload,
    });

    await runTool(tool, {
      event_data: {user_id: 'user123', action: 'login'},
      subject: 'user123',
    });

    const event = onlyEvent();
    expect(event.type).toBe('action.login');
    expect(event.source).toBe('my-source');
    const attributes = eventAttributes(event);
    expect(attributes['subject']).toBe('user123');
    expect(attributes).not.toHaveProperty('time');
    expect(event.textData).toBe('{"user_id":"user123","action":"login"}');
  });

  it('test_runtime_execution_explicit_null_fallback', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: 'my-type',
        source: 'my-source',
        subject: new AgentProvided({
          description: 'Subject',
          default: 'fallback-subject',
        }),
      },
    });

    await runTool(tool, {subject: undefined});

    expect(eventAttributes(onlyEvent())['subject']).toBe('fallback-subject');
  });

  it('test_runtime_mandatory_omit_raises', async () => {
    const tool = buildTool({
      ceAttributesBinding: {type: () => OMIT, source: 'my-source'},
    });

    await expect(
      tool.runAsync({args: {}, toolContext: toolContext()}),
    ).rejects.toThrow(
      "Mandatory CloudEvent attribute 'type' cannot evaluate to OMIT.",
    );
  });

  it('test_runtime_agent_provided_missing_raises', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: new AgentProvided({description: 'The type'}),
        source: 'my-source',
      },
    });

    // The generated schema makes an AgentProvided attribute with no default a
    // required parameter, so the call is rejected before any binding resolves.
    await expect(
      tool.runAsync({args: {}, toolContext: toolContext()}),
    ).rejects.toThrow('expected string, received undefined');
  });

  it('test_runtime_agent_provided_bus_missing_raises', async () => {
    const tool = buildTool({
      bus: new AgentProvided({description: 'The bus'}),
      ceAttributesBinding: {type: 'my-type', source: 'my-source'},
    });

    await expect(
      tool.runAsync({args: {}, toolContext: toolContext()}),
    ).rejects.toThrow('expected string, received undefined');
  });

  it('test_optional_fields_as_none_are_ignored', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: 'my-type',
        source: 'my-source',
        time: undefined,
        subject: undefined,
        id: undefined,
      },
    });

    await runTool(tool);

    const event = onlyEvent();
    const attributes = eventAttributes(event);
    expect(attributes).not.toHaveProperty('subject');
    // `time` and `id` are not left off: an unbound `time` defaults to now and
    // an unbound `id` to a fresh UUID, exactly as the generic tool does.
    expect(attributes['time']).toBeDefined();
    expect(event.id).toBeDefined();
  });

  it('test_time_and_datacontenttype_omit_pass_empty_string', async () => {
    const tool = buildTool({
      ceAttributesBinding: {
        type: 'my-type',
        source: 'my-source',
        time: OMIT,
        datacontenttype: OMIT,
      },
      payloadSchema: dummyPayload,
    });

    await runTool(tool, {event_data: {user_id: 'u1', action: 'a1'}});

    const attributes = eventAttributes(onlyEvent());
    expect(attributes).not.toHaveProperty('time');
    expect(attributes).not.toHaveProperty('datacontenttype');
  });
});
