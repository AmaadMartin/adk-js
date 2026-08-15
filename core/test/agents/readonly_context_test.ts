/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Context,
  createSession,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  ReadonlyContext,
  RunConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createRunConfig} from '../../src/agents/run_config.js';

function makeInvocationContext(runConfig?: RunConfig): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({id: 'sess-1', appName: 'app', userId: 'user-1'}),
    pluginManager: new PluginManager(),
    runConfig,
  });
}

/** The mutable alias of the view's type, to exercise the runtime guard. */
function asMutable(
  view: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return view as Record<string, unknown>;
}

describe('ReadonlyContext.customMetadata', () => {
  it('reads the metadata seeded from the run config', () => {
    const ic = makeInvocationContext(
      createRunConfig({customMetadata: {tenant: 'acme'}}),
    );

    expect(new ReadonlyContext(ic).customMetadata['tenant']).toBe('acme');
  });

  it('is an empty view when the invocation has no run config', () => {
    const view = new ReadonlyContext(makeInvocationContext()).customMetadata;

    expect(view).toBeDefined();
    expect(Object.keys(view)).toEqual([]);
  });

  it('is an empty view when the run config sets no custom metadata', () => {
    const view = new ReadonlyContext(
      makeInvocationContext(createRunConfig({maxLlmCalls: 3})),
    ).customMetadata;

    expect(Object.keys(view)).toEqual([]);
  });

  it('throws on a write and leaves the store untouched', () => {
    const ic = makeInvocationContext(
      createRunConfig({customMetadata: {tenant: 'acme'}}),
    );
    const view = new ReadonlyContext(ic).customMetadata;

    expect(() => {
      asMutable(view)['injected'] = 'value';
    }).toThrow(TypeError);
    expect(ic.customMetadata).not.toHaveProperty('injected');
  });

  it('throws on a delete and leaves the store untouched', () => {
    const ic = makeInvocationContext(
      createRunConfig({customMetadata: {tenant: 'acme'}}),
    );
    const view = new ReadonlyContext(ic).customMetadata;

    expect(() => {
      delete asMutable(view)['tenant'];
    }).toThrow(TypeError);
    expect(ic.customMetadata['tenant']).toBe('acme');
  });

  it('names the key but not the value in the write error', () => {
    const ic = makeInvocationContext();
    const view = new ReadonlyContext(ic).customMetadata;

    expect(() => {
      asMutable(view)['apiKey'] = 'super-secret';
    }).toThrow(/'apiKey'/);
    expect(() => {
      asMutable(view)['apiKey'] = 'super-secret';
    }).not.toThrow(/super-secret/);
  });

  it('reads a value written to the store after the view was taken', () => {
    const ic = makeInvocationContext();
    const view = new ReadonlyContext(ic).customMetadata;

    ic.customMetadata['httpDebugInfo'] = ['GET /v1'];

    expect(view['httpDebugInfo']).toEqual(['GET /v1']);
  });

  it('copies the run config metadata instead of aliasing it', () => {
    const configured = {tenant: 'acme'};
    const ic = makeInvocationContext(
      createRunConfig({customMetadata: configured}),
    );

    ic.customMetadata['tenant'] = 'other';

    expect(configured).toEqual({tenant: 'acme'});
  });

  it('shares one store with a cloned context', () => {
    const ic = makeInvocationContext(
      createRunConfig({customMetadata: {tenant: 'acme'}}),
    );
    const clone = ic.clone();

    ic.customMetadata['requestId'] = 'r-1';

    expect(new ReadonlyContext(clone).customMetadata).toEqual({
      tenant: 'acme',
      requestId: 'r-1',
    });
  });

  it('shares one store with a child agent context', () => {
    const ic = makeInvocationContext(
      createRunConfig({customMetadata: {tenant: 'acme'}}),
    );
    const child = new InvocationContext({
      ...ic,
      agent: new LlmAgent({name: 'sub'}),
    });

    ic.customMetadata['requestId'] = 'r-1';

    expect(new ReadonlyContext(child).customMetadata['requestId']).toBe('r-1');
    expect(child.customMetadata).toBe(ic.customMetadata);
  });

  it('is inherited by Context', () => {
    const ic = makeInvocationContext(
      createRunConfig({customMetadata: {tenant: 'acme'}}),
    );

    const ctx = new Context({invocationContext: ic});

    expect(ctx.customMetadata['tenant']).toBe('acme');
    expect(() => {
      asMutable(ctx.customMetadata)['tenant'] = 'other';
    }).toThrow(TypeError);
  });
});

class MockLlmConnection implements BaseLlmConnection {
  sendHistory(): Promise<void> {
    return Promise.resolve();
  }
  sendContent(): Promise<void> {
    return Promise.resolve();
  }
  sendRealtime(): Promise<void> {
    return Promise.resolve();
  }
  async *receive(): AsyncGenerator<LlmResponse, void, void> {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Records the request the agent builds, so the rendered instruction can be
 * asserted after a real run. */
class CapturingLlm extends BaseLlm {
  capturedRequest?: LlmRequest;

  constructor() {
    super({model: 'mock-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.capturedRequest = request;
    yield {content: {role: 'model', parts: [{text: 'ok'}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

describe('customMetadata through a runner-driven agent run', () => {
  it('hands an instruction provider the metadata set on the run config', async () => {
    const llm = new CapturingLlm();
    const agent = new LlmAgent({
      name: 'tenant_agent',
      model: llm,
      instruction: (ctx: ReadonlyContext) =>
        `You are serving tenant ${ctx.customMetadata['tenant']}.`,
    });
    const runner = new InMemoryRunner({agent});
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user-1',
    });

    for await (const _ of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'hi'}]},
      runConfig: {customMetadata: {tenant: 'acme'}},
    })) {
      // Drain the run so the request is fully built.
    }

    expect(llm.capturedRequest?.config?.systemInstruction).toContain(
      'You are serving tenant acme.',
    );
  });

  it('hands an instruction provider an empty view when the run sets no metadata', async () => {
    const llm = new CapturingLlm();
    const agent = new LlmAgent({
      name: 'tenant_agent',
      model: llm,
      instruction: (ctx: ReadonlyContext) =>
        `Tenants: ${Object.keys(ctx.customMetadata).length}.`,
    });
    const runner = new InMemoryRunner({agent});
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user-1',
    });

    for await (const _ of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'hi'}]},
    })) {
      // Drain the run so the request is fully built.
    }

    expect(llm.capturedRequest?.config?.systemInstruction).toContain(
      'Tenants: 0.',
    );
  });
});
