/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {AuthCredentialTypes} from '../../src/auth/auth_credential.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../../src/workflow/utils/hitl_utils.js';
import {createIc, driveNode} from './test_helpers.js';

describe('FunctionNode result handling', () => {
  it('yields one event per item from a generator handler', async () => {
    const node = new FunctionNode('gen', function* () {
      yield 'a';
      yield 'b';
    });
    const {events, output} = await driveNode(node);
    expect(events.map((e) => e.output)).toEqual(['a', 'b']);
    expect(output).toBe('b');
  });

  it('emits a genai Content result as the event content', async () => {
    const node = new FunctionNode('c', () => ({
      role: 'model',
      parts: [{text: 'hi'}],
    }));
    const {events} = await driveNode(node);
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe('hi');
  });

  it('skips a null result with no pending state', async () => {
    const node = new FunctionNode('n', () => null);
    const {events, output} = await driveNode(node);
    expect(events).toHaveLength(0);
    expect(output).toBeUndefined();
  });

  it('passes an explicitly returned Event through', async () => {
    const node = new FunctionNode('e', () => createEvent({output: 'x'}));
    const {output} = await driveNode(node);
    expect(output).toBe('x');
  });
});

describe('FunctionNode state delta attachment', () => {
  it('attaches each written key only once across a multi-event run', async () => {
    const node = new FunctionNode('w', function* (ctx) {
      ctx.state.set('k', 1);
      yield 'a';
      yield 'b';
    });
    const {events} = await driveNode(node);
    // First event carries the write; the second does not re-emit it.
    expect(events[0].actions.stateDelta).toEqual({k: 1});
    expect(events[1].actions.stateDelta).toEqual({});
  });

  it('lets a handler-set event delta win over the context delta', async () => {
    const node = new FunctionNode('w', function* (ctx) {
      ctx.state.set('k', 'ctx');
      yield createEvent({output: 'x', actions: {stateDelta: {k: 'handler'}}});
    });
    const {events} = await driveNode(node);
    expect(events.at(-1)?.actions.stateDelta.k).toBe('handler');
  });
});

describe('FunctionNode auth gate', () => {
  const apiKeyConfig = (): AuthConfig => ({
    credentialKey: 'k',
    authScheme: {type: 'apiKey', name: 'k', in: 'header'},
    rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
  });

  it('interrupts with a credential request when none is available', async () => {
    const node = new FunctionNode('needsAuth', () => 'ran', {
      authConfig: apiKeyConfig(),
      rerunOnResume: true,
    });
    const {events, output} = await driveNode(node, 'x');

    // The handler never ran; a credential-request interrupt was emitted instead.
    expect(output).toBeUndefined();
    const fc = events.at(-1)?.content?.parts?.[0]?.functionCall;
    expect(fc?.name).toBe(REQUEST_CREDENTIAL_FUNCTION_CALL_NAME);
    expect(events.at(-1)?.longRunningToolIds).toContain('k');
  });

  it('proceeds when the credential is supplied via resumeInputs', async () => {
    const node = new FunctionNode('needsAuth', () => 'ran', {
      authConfig: apiKeyConfig(),
      rerunOnResume: true,
    });
    const channel = new AsyncQueue<Event>();
    const root = new NodeContext({
      invocationContext: createIc(),
      channel,
      nodePath: '',
      runId: 'root',
      resumeInputs: {k: 'my-key'},
    });
    const child = await root.runNode(node, 'x', {useAsOutput: true});
    expect(child.output).toBe('ran');
  });
});

describe('FunctionNode RequestInput handling', () => {
  it('emits an interrupt event for a returned RequestInput', async () => {
    // `FunctionNodeResult` carries `RequestInput`, so no cast is needed here.
    const node = new FunctionNode(
      'ask',
      () => new RequestInput({interruptId: 'ask-1', message: 'Approve?'}),
    );

    const {events} = await driveNode(node, 'x');

    const fc = events[0]?.content?.parts?.[0]?.functionCall;
    expect(fc?.name).toBe(REQUEST_INPUT_FUNCTION_CALL_NAME);
    expect(fc?.id).toBe('ask-1');
    expect(events[0].longRunningToolIds).toContain('ask-1');
  });

  it('keeps a pending state delta on the event after the interrupt', async () => {
    // `BaseNode.run` converts the RequestInput without reaching `toEvent`, so
    // the delta is not drained by it and still reaches the next event.
    const node = new FunctionNode('ask', function* (ctx) {
      ctx.state.set('k', 1);
      yield new RequestInput({interruptId: 'ask-2'});
      yield 'after';
    });

    const {events} = await driveNode(node, 'x');

    expect(events).toHaveLength(2);
    expect(events[1].output).toBe('after');
    expect(events[1].actions.stateDelta).toEqual({k: 1});
  });
});

describe('FunctionNode construction', () => {
  it('builds with a parameter JSON Schema cannot express', async () => {
    // Rendering the whole schema as JSON Schema throws for `z.date()`, which
    // used to abort construction with a raw Zod error naming neither the node
    // nor the parameter.
    const parameters = z.object({name: z.string(), when: z.date()});
    const record = (
      _ctx: NodeContext,
      {name, when}: z.infer<typeof parameters>,
    ) => `${name}@${when.toISOString()}`;
    const node = new FunctionNode(record, {
      parameters,
      parameterBinding: 'nodeInput',
    });

    const {output} = await driveNode(node, {
      name: 'ada',
      when: new Date('2026-01-01T00:00:00Z'),
    });

    expect(output).toBe('ada@2026-01-01T00:00:00.000Z');
  });

  it('coerces a declared parameter with the field its schema declares', async () => {
    const parameters = z.object({count: z.coerce.number()});
    const twice = (_ctx: NodeContext, {count}: z.infer<typeof parameters>) =>
      count * 2;
    const node = new FunctionNode(twice, {
      parameters,
      parameterBinding: 'nodeInput',
    });

    expect((await driveNode(node, {count: '21'})).output).toBe(42);
  });

  it('takes its name from the wrapped function when none is given', () => {
    const greet = () => 'hi';

    expect(new FunctionNode(greet).name).toBe('greet');
    expect(new FunctionNode(greet, {description: 'd'}).description).toBe('d');
  });

  it('prefers an explicit name over the function name', () => {
    const greet = () => 'hi';

    expect(new FunctionNode('welcome', greet).name).toBe('welcome');
    expect(new FunctionNode(greet, {name: 'welcome'}).name).toBe('welcome');
  });

  it('rejects a handler with no resolvable name', () => {
    // An arrow inside an array literal gets no inferred name, so `.name` is ''.
    const [anonymous] = [() => 'hi'];

    expect(() => new FunctionNode(anonymous)).toThrow(
      'FunctionNode must have a name',
    );
  });
});
