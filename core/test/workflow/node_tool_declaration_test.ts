/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The declaration shapes the adk-python reference does not pin: a non-string
 * scalar input schema, the Zod-object path that keeps emitting genai
 * `parameters`, and `responseJsonSchema` from a genai output schema.
 */

import {
  AsyncQueue,
  Context,
  Event,
  NodeContext,
  NodeTool,
  Workflow,
  node,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';
import {createIc} from './test_helpers.js';

describe('NodeTool declaration', () => {
  it('advertises a numeric scalar input schema as a number, not a string', () => {
    const target = node((_ctx: NodeContext, input: number) => input * 2, {
      name: 'doubler',
      inputSchema: z.number(),
    });
    const parameters = new NodeTool(target)._getDeclaration()
      .parametersJsonSchema as Record<string, Record<string, unknown>>;
    expect(parameters['type']).toBe('object');
    // `toJsonSchema` carries Zod v3's `$schema` key through, so match the type
    // rather than the whole property object.
    expect(parameters['properties']).toMatchObject({request: {type: 'number'}});
    expect(parameters['required']).toEqual(['request']);
  });

  it('unwraps a numeric scalar argument on the way into the node', async () => {
    const target = node((_ctx: NodeContext, input: number) => input * 2, {
      name: 'doubler',
      inputSchema: z.number(),
    });
    const ic = createIc();
    ic.eventQueue = new AsyncQueue<Event>();
    const result = await new NodeTool(target).runAsync({
      args: {request: 21},
      toolContext: new Context({
        invocationContext: ic,
        functionCallId: 'fc-1',
      }),
    });
    expect(result).toBe(42);
  });

  it('keeps emitting genai parameters for a Zod object input schema', () => {
    const target = node((_ctx: NodeContext, input: {topic: string}) => input, {
      name: 'zod_object_node',
      inputSchema: z.object({topic: z.string()}),
    });
    const declaration = new NodeTool(target)._getDeclaration();
    expect(declaration.parameters).toMatchObject({
      type: Type.OBJECT,
      properties: {topic: {type: Type.STRING}},
    });
    expect(declaration.parametersJsonSchema).toBeUndefined();
  });

  it('publishes an object-typed genai input schema unwrapped', () => {
    const target = node((_ctx: NodeContext, input: unknown) => input, {
      name: 'genai_object_node',
      inputSchema: {
        type: Type.OBJECT,
        properties: {topic: {type: Type.STRING}},
        required: ['topic'],
      },
    });
    const declaration = new NodeTool(target)._getDeclaration();
    expect(declaration.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {topic: {type: 'string'}},
      required: ['topic'],
    });
    expect(declaration.parameters).toBeUndefined();
  });

  it('publishes a genai output schema as responseJsonSchema', () => {
    const target = node((_ctx: NodeContext) => ({tier: 'gold'}), {
      name: 'tier_node',
      inputSchema: z.object({}),
      outputSchema: {
        type: Type.OBJECT,
        properties: {tier: {type: Type.STRING}},
      },
    });
    const declaration = new NodeTool(target)._getDeclaration();
    expect(declaration.responseJsonSchema).toEqual({
      type: 'object',
      properties: {tier: {type: 'string'}},
    });
    expect(declaration.response).toBeUndefined();
  });

  it('leaves responseJsonSchema unset when the node has no output schema', () => {
    const target = node((_ctx: NodeContext) => 'ok', {
      name: 'schemaless_output',
      inputSchema: z.object({}),
    });
    expect(
      new NodeTool(target)._getDeclaration().responseJsonSchema,
    ).toBeUndefined();
  });

  it('wraps a Workflow, which is a node and not an agent', () => {
    const wf = new Workflow({
      name: 'lookup_wf',
      inputSchema: z.object({userId: z.string()}),
      edges: [['START', node(() => 'ok', {name: 'step'})]],
    });
    const tool = new NodeTool(wf);
    expect(tool.name).toBe('lookup_wf');
    expect(tool.isLongRunning).toBe(true);
    expect(tool._getDeclaration().parameters).toMatchObject({
      type: Type.OBJECT,
      properties: {userId: {type: Type.STRING}},
    });
  });
});
