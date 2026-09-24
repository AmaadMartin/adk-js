/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases adk-python's test file covers through Python-only machinery, rewritten
 * for this port, plus the toolset wiring `createPublishTool` adds.
 */

import {
  AgentProvided,
  cleanupClients,
  EventarcPublishStatus,
  EventarcToolset,
  OMIT,
  PUBLISH_MESSAGE_TOOL_NAME,
  type Context,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  builtClients,
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

describe('createPublishTool on the toolset', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
  });

  it('adds the tool to the toolset and returns it', async () => {
    const toolset = new EventarcToolset({toolConfig: SETTINGS});

    const tool = toolset.createPublishTool({
      name: 'report_escalation',
      description: 'Reports an escalation.',
      bus: BUS,
      ceAttributesBinding: {type: 'com.example.escalated', source: '//support'},
    });

    const tools = await toolset.getTools();
    expect(tools.map((each) => each.name)).toEqual([
      PUBLISH_MESSAGE_TOOL_NAME,
      'report_escalation',
    ]);
    expect(tools[1]).toBe(tool);
  });

  it('publishes with the credentials and settings the toolset holds', async () => {
    const toolset = new EventarcToolset({
      toolConfig: {projectId: 'bound-project', publishTimeoutMs: 4321},
    });
    const tool = toolset.createPublishTool({
      name: 'report',
      description: 'Reports.',
      bus: BUS,
      ceAttributesBinding: {type: 'com.example.x', source: '//src'},
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: toolContext(),
    });

    expect(result).toMatchObject({status: EventarcPublishStatus.SUCCESS});
    expect(builtClients[0].options?.projectId).toBe('bound-project');
    expect(builtClients[0].publishes[0].options?.timeout).toBe(4321);
  });

  it('keeps the model out of the bus and the project', async () => {
    const toolset = new EventarcToolset({toolConfig: SETTINGS});

    const tool = toolset.createPublishTool({
      name: 'report',
      description: 'Reports.',
      bus: BUS,
      ceAttributesBinding: {type: 'com.example.x', source: '//src'},
    });

    const properties = tool._getDeclaration()?.parameters?.properties ?? {};
    expect(Object.keys(properties)).toEqual([]);
  });
});

describe('custom attribute keys TypeScript does not have to rename', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
  });

  // Replaces adk-python's `test_runtime_execution_with_python_keywords`.
  // Python renames `self`, `cls` and a leading-digit key to make them valid
  // identifiers. TypeScript object keys need no renaming, so each key must
  // reach the CloudEvent spelled exactly as it was written.
  it('round-trips a reserved word and a leading-digit key unchanged', async () => {
    const toolset = new EventarcToolset({toolConfig: SETTINGS});
    const tool = toolset.createPublishTool({
      name: 'report',
      description: 'Reports.',
      bus: BUS,
      ceAttributesBinding: {
        type: 'com.example.x',
        source: '//src',
        customAttributes: {
          self: new AgentProvided({description: 'self'}),
          cls: new AgentProvided({description: 'cls'}),
          '2fa': new AgentProvided({description: 'second factor'}),
          '123foo': new AgentProvided({description: 'digits first'}),
        },
      },
    });

    const properties = tool._getDeclaration()?.parameters?.properties ?? {};
    expect(Object.keys(properties).sort()).toEqual([
      '123foo',
      '2fa',
      'cls',
      'self',
    ]);

    await tool.runAsync({
      args: {
        self: 'self_value',
        cls: 'cls_value',
        '2fa': 'sms',
        '123foo': 'foo_value',
      },
      toolContext: toolContext(),
    });

    const attributes = eventAttributes(onlyEvent());
    expect(attributes['self']).toBe('self_value');
    expect(attributes['cls']).toBe('cls_value');
    expect(attributes['2fa']).toBe('sms');
    expect(attributes['123foo']).toBe('foo_value');
  });
});

describe('resolver bindings take a fixed argument order', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
  });

  // Replaces adk-python's
  // `test_runtime_execution_with_context_and_payload_lambdas`. Python reads a
  // lambda's parameter names to choose the argument order; this port always
  // passes `(payload, toolContext)`.
  it('passes the payload first and the tool context second', async () => {
    const seen: Array<{payload: unknown; hasContext: boolean}> = [];
    const toolset = new EventarcToolset({toolConfig: SETTINGS});
    const tool = toolset.createPublishTool({
      name: 'report',
      description: 'Reports.',
      bus: BUS,
      ceAttributesBinding: {
        // Reads only the payload.
        type: (payload) => `action.${(payload as {action: string}).action}`,
        // Reads only the context.
        source: (_payload, ctx?: Context) =>
          `//agent/${ctx?.invocationContext.session.id}`,
        // Reads both.
        subject: (payload, ctx?: Context) => {
          seen.push({payload, hasContext: ctx !== undefined});
          return `${(payload as {user_id: string}).user_id}@${
            ctx?.invocationContext.invocationId
          }`;
        },
      },
      payloadSchema: z.object({user_id: z.string(), action: z.string()}),
    });

    await tool.runAsync({
      args: {event_data: {user_id: 'u1', action: 'login'}},
      toolContext: toolContext(),
    });

    const event = onlyEvent();
    expect(event.type).toBe('action.login');
    expect(event.source).toBe('//agent/test-session');
    expect(eventAttributes(event)['subject']).toBe('u1@test-invocation');
    expect(seen).toEqual([
      {payload: {user_id: 'u1', action: 'login'}, hasContext: true},
    ]);
  });

  it('leaves an attribute off when its resolver returns OMIT', async () => {
    const toolset = new EventarcToolset({toolConfig: SETTINGS});
    const tool = toolset.createPublishTool({
      name: 'report',
      description: 'Reports.',
      bus: BUS,
      ceAttributesBinding: {
        type: 'com.example.x',
        source: '//src',
        subject: () => OMIT,
      },
    });

    await tool.runAsync({args: {}, toolContext: toolContext()});

    expect(eventAttributes(onlyEvent())).not.toHaveProperty('subject');
  });

  it('rejects a bus resolver that returns OMIT', async () => {
    const toolset = new EventarcToolset({toolConfig: SETTINGS});
    const tool = toolset.createPublishTool({
      name: 'report',
      description: 'Reports.',
      bus: () => OMIT,
      ceAttributesBinding: {type: 'com.example.x', source: '//src'},
    });

    await expect(
      tool.runAsync({args: {}, toolContext: toolContext()}),
    ).rejects.toThrow(
      "Mandatory attribute 'bus' cannot evaluate to None or OMIT.",
    );
  });

  // Build-time validation only rejects a literal OMIT. A resolver that
  // returns OMIT is caught when the tool runs.
  it.each(['id', 'specversion'])(
    'rejects a %s resolver that returns OMIT',
    async (field) => {
      const toolset = new EventarcToolset({toolConfig: SETTINGS});
      const tool = toolset.createPublishTool({
        name: 'report',
        description: 'Reports.',
        bus: BUS,
        ceAttributesBinding: {
          type: 'com.example.x',
          source: '//src',
          [field]: () => OMIT,
        },
      });

      await expect(
        tool.runAsync({args: {}, toolContext: toolContext()}),
      ).rejects.toThrow(
        `CloudEvent attribute '${field}' is mandatory and cannot be OMIT.`,
      );
    },
  );

  it('publishes a bound id, spec version and time', async () => {
    const toolset = new EventarcToolset({toolConfig: SETTINGS});
    const tool = toolset.createPublishTool({
      name: 'report',
      description: 'Reports.',
      bus: BUS,
      ceAttributesBinding: {
        type: 'com.example.x',
        source: '//src',
        id: 'fixed-event-id',
        specversion: '1.0',
        time: '2026-01-02T03:04:05Z',
      },
    });

    await tool.runAsync({args: {}, toolContext: toolContext()});

    const event = onlyEvent();
    expect(event.id).toBe('fixed-event-id');
    expect(event.specVersion).toBe('1.0');
    expect(eventAttributes(event)['time']).toBe('2026-01-02T03:04:05Z');
  });

  it('resolves the bus from the payload', async () => {
    const toolset = new EventarcToolset({toolConfig: SETTINGS});
    const tool = toolset.createPublishTool({
      name: 'report',
      description: 'Reports.',
      bus: (payload) => (payload as {bus: string}).bus,
      ceAttributesBinding: {type: 'com.example.x', source: '//src'},
      payloadSchema: z.object({bus: z.string()}),
    });

    await tool.runAsync({
      args: {event_data: {bus: BUS}},
      toolContext: toolContext(),
    });

    expect(builtClients[0].publishes[0].request.messageBus).toBe(BUS);
  });
});
