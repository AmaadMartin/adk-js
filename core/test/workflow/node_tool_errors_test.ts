/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `NodeTool` input and error paths the adk-python reference does not cover:
 * how the model's arguments are validated, the two error strings a tool result
 * carries, which errors keep propagating instead, and the pre-flight checks
 * that stay throws because they report a misconfigured host rather than a
 * failing node.
 */

import {
  AsyncQueue,
  Context,
  Event,
  FunctionNode,
  getFunctionResponses,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  node,
  NodeContext,
  NodeTool,
  RequestInput,
  Workflow,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {createIc, ScriptedLlm} from './test_helpers.js';

/** Runs `tool` the way an `LlmAgent` tool-call step does. */
function runTool(
  tool: NodeTool,
  args: Record<string, unknown>,
  options: {ic?: InvocationContext; functionCallId?: string} = {},
): Promise<unknown> {
  const ic = options.ic ?? createIc();
  ic.eventQueue = new AsyncQueue<Event>();
  const toolContext = new Context({
    invocationContext: ic,
    functionCallId: options.functionCallId ?? 'fc-1',
  });
  return tool.runAsync({args, toolContext});
}

describe('NodeTool error paths', () => {
  it('returns a validation error when the model arguments fail the schema', async () => {
    const target = node((_ctx: NodeContext, input: {topic: string}) => input, {
      name: 'research',
      inputSchema: z.object({topic: z.string()}),
    });
    const result = await runTool(new NodeTool(target), {topic: 42});
    expect(result).toMatch(/^Error validating input for node: /);
  });

  it('parses a transforming schema once, so the node sees the transform', async () => {
    // The up-front check must not hand the node an already-parsed value: the
    // node parses its own input, and `.transform()` is not idempotent here.
    const target = node(
      (_ctx: NodeContext, input: {n: number}) => ({got: input.n}),
      {
        name: 'transformer',
        inputSchema: z.object({n: z.string().transform(Number)}),
      },
    );
    const result = await runTool(new NodeTool(target), {n: '21'});
    expect(result).toEqual({got: 21});
  });

  it('parses a transforming scalar schema once', async () => {
    const target = node((_ctx: NodeContext, input: number) => ({got: input}), {
      name: 'scalar_transformer',
      inputSchema: z.string().transform(Number),
    });
    const result = await runTool(new NodeTool(target), {request: '21'});
    expect(result).toEqual({got: 21});
  });

  it('runs a Zod v4 object schema holding a transform', async () => {
    // Zod v4 refuses to serialize a `.transform()`, so nothing on this path may
    // ask it to: the object declaration comes from `zodObjectToSchema`.
    const target = node(
      (_ctx: NodeContext, input: {q: string}) => ({got: input.q}),
      {
        name: 'v4_object_transformer',
        inputSchema: z4.object({q: z4.string().transform((s) => s.trim())}),
      },
    );
    const tool = new NodeTool(target);
    expect(tool._getDeclaration().parameters).toMatchObject({
      type: Type.OBJECT,
      properties: {q: {type: Type.STRING}},
    });
    expect(await runTool(tool, {q: '  kelp  '})).toEqual({got: 'kelp'});
  });

  it('runs a Zod v4 scalar schema holding a transform', async () => {
    const target = node((_ctx: NodeContext, input: number) => ({got: input}), {
      name: 'v4_scalar_transformer',
      inputSchema: z4.string().transform(Number),
    });
    const tool = new NodeTool(target);
    // No JSON Schema form, so the declaration carries no parameters rather
    // than the tool call failing.
    expect(tool._getDeclaration().parametersJsonSchema).toBeUndefined();
    expect(await runTool(tool, {request: '21'})).toEqual({got: 21});
  });

  it('runs a node whose Zod v4 output schema holds a transform', async () => {
    const target = node((_ctx: NodeContext) => 'gold', {
      name: 'v4_output_transformer',
      inputSchema: z4.object({}),
      outputSchema: z4.string().transform((s) => s.toUpperCase()),
    });
    const tool = new NodeTool(target);
    expect(tool._getDeclaration().responseJsonSchema).toBeUndefined();
    expect(await runTool(tool, {})).toBe('GOLD');
  });

  it('serves a v4 transforming node through a whole agent turn', async () => {
    // The declaration is built while the agent starts, so a schema that cannot
    // be serialized used to end the turn with an uncaught error.
    const target = node(
      (_ctx: NodeContext, input: {q: string}) => ({got: input.q}),
      {
        name: 'trimmer',
        inputSchema: z4.object({q: z4.string().transform((s) => s.trim())}),
      },
    );
    const agent = new LlmAgent({
      name: 'trimming_agent',
      model: new ScriptedLlm([
        {functionCall: {id: 'fc-1', name: 'trimmer', args: {q: '  kelp  '}}},
        'Finished.',
      ]),
      tools: [target],
    });
    const runner = new InMemoryRunner({agent, appName: agent.name});
    const session = await runner.sessionService.createSession({
      appName: agent.name,
      userId: 'u1',
    });
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Trim it.'}]},
    })) {
      events.push(event);
    }
    const responses = events.flatMap((event) => getFunctionResponses(event));
    expect(responses).toHaveLength(1);
    expect(responses[0].response).toEqual({got: 'kelp'});
  });

  it('returns a run error when the node throws', async () => {
    const target = node(
      () => {
        throw new Error('boom');
      },
      {name: 'exploder', inputSchema: z.object({})},
    );
    const result = await runTool(new NodeTool(target), {});
    expect(result).toBe('Error running node exploder: boom');
  });

  it('re-throws an aborted invocation instead of reporting it to the model', async () => {
    // The node runner races a node against its abort signal only when the node
    // declares a timeout, so the node under test carries one it never reaches.
    const target = node(() => 'never', {
      name: 'cancelled',
      inputSchema: z.object({}),
      timeout: 30,
    });
    const controller = new AbortController();
    controller.abort();
    const ic = createIc({}, controller.signal);
    await expect(runTool(new NodeTool(target), {}, {ic})).rejects.toThrow(
      /Invocation aborted/,
    );
  });

  it('re-throws a dynamic node failure instead of reporting it to the model', async () => {
    const boom = new FunctionNode('boom', () => {
      throw new Error('child exploded');
    });
    const caller = new FunctionNode('caller', async (ctx: NodeContext) => {
      await ctx.runNode(boom);
      return 'unreachable';
    });
    const wf = new Workflow({
      name: 'dynamic_wf',
      inputSchema: z.object({}),
      edges: [['START', caller]],
    });
    await expect(runTool(new NodeTool(wf), {})).rejects.toThrow(
      /Dynamic node boom failed/,
    );
  });

  it('returns undefined while the node waits for input', async () => {
    const target = new FunctionNode('approval', (ctx: NodeContext) =>
      ctx.resumeInputs['approve-1'] === undefined
        ? new RequestInput({interruptId: 'approve-1', message: 'approve?'})
        : 'approved',
    );
    const result = await runTool(new NodeTool(target), {});
    expect(result).toBeUndefined();
  });

  it('throws when there is no invocation event queue', async () => {
    const target = node(() => 'ok', {
      name: 'queueless',
      inputSchema: z.object({}),
    });
    const toolContext = new Context({
      invocationContext: createIc(),
      functionCallId: 'fc-1',
    });
    await expect(
      new NodeTool(target).runAsync({args: {}, toolContext}),
    ).rejects.toThrow(/requires an invocation event queue/);
  });

  it('throws when there is no function-call id', async () => {
    const target = node(() => 'ok', {
      name: 'idless',
      inputSchema: z.object({}),
    });
    const ic = createIc();
    ic.eventQueue = new AsyncQueue<Event>();
    const toolContext = new Context({invocationContext: ic});
    await expect(
      new NodeTool(target).runAsync({args: {}, toolContext}),
    ).rejects.toThrow(/requires a function-call id/);
  });

  it('throws when the node-tool nesting depth is exceeded', async () => {
    const target = node(() => 'ok', {
      name: 'deep',
      inputSchema: z.object({}),
    });
    const ic = createIc().clone({nodeToolDepth: 8});
    await expect(runTool(new NodeTool(target), {}, {ic})).rejects.toThrow(
      /nesting exceeded 8/,
    );
  });

  it('leaves a genai Schema to the node, which reports the failure as a run error', async () => {
    const target = node((_ctx: NodeContext, input: unknown) => input, {
      name: 'genai_schema_node',
      inputSchema: {
        type: Type.OBJECT,
        properties: {topic: {type: Type.STRING}},
        required: ['topic'],
      },
    });
    const result = await runTool(new NodeTool(target), {topic: 42});
    // Not "Error validating input for node": only a Zod schema is checked up
    // front, so the node's own `validateInput` is what rejects this.
    expect(result).toMatch(/^Error running node genai_schema_node: /);
  });

  it('passes an object-typed genai Schema through without unwrapping request', async () => {
    const target = node((_ctx: NodeContext, input: unknown) => input, {
      name: 'genai_object_node',
      inputSchema: {
        type: Type.OBJECT,
        properties: {topic: {type: Type.STRING}},
        required: ['topic'],
      },
    });
    const result = await runTool(new NodeTool(target), {topic: 'kelp'});
    expect(result).toEqual({topic: 'kelp'});
  });
});
