/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  BaseTool,
  Context,
  Event,
  InvocationContext,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {Content} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ContextCompactionTrigger} from '../../src/plugins/base_plugin.js';
import {isPluginCloseTimeoutError} from '../../src/plugins/plugin_manager.js';
import {resetLogger, setLogger} from '../../src/utils/logger.js';

type PluginCallbackName = keyof BasePlugin;

class TestPlugin extends BasePlugin {
  callLog: PluginCallbackName[] = [];
  returnValues: Partial<Record<PluginCallbackName, unknown>> = {};
  exceptionsToRaise: Partial<Record<PluginCallbackName, Error>> = {};

  constructor(name: string) {
    super(name);
  }

  private async handleCallback(
    name: PluginCallbackName,
  ): Promise<unknown | undefined> {
    this.callLog.push(name);
    if (this.exceptionsToRaise[name]) {
      throw this.exceptionsToRaise[name];
    }
    return this.returnValues[name];
  }

  override async onUserMessageCallback(_params: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    return (await this.handleCallback('onUserMessageCallback')) as
      | Content
      | undefined;
  }

  override async beforeRunCallback(_params: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    return (await this.handleCallback('beforeRunCallback')) as
      | Content
      | undefined;
  }

  override async afterRunCallback(_params: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    await this.handleCallback('afterRunCallback');
  }

  override async onEventCallback(_params: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    return (await this.handleCallback('onEventCallback')) as Event | undefined;
  }

  override async beforeAgentCallback(_params: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    return (await this.handleCallback('beforeAgentCallback')) as
      | Content
      | undefined;
  }

  override async afterAgentCallback(_params: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    return (await this.handleCallback('afterAgentCallback')) as
      | Content
      | undefined;
  }

  override async beforeToolCallback(_params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    return (await this.handleCallback('beforeToolCallback')) as
      | Record<string, unknown>
      | undefined;
  }

  override async afterToolCallback(_params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    return (await this.handleCallback('afterToolCallback')) as
      | Record<string, unknown>
      | undefined;
  }

  override async onToolErrorCallback(_params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    return (await this.handleCallback('onToolErrorCallback')) as
      | Record<string, unknown>
      | undefined;
  }

  override async beforeModelCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    return (await this.handleCallback('beforeModelCallback')) as
      | LlmResponse
      | undefined;
  }

  override async afterModelCallback(_params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    return (await this.handleCallback('afterModelCallback')) as
      | LlmResponse
      | undefined;
  }

  override async onModelErrorCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    return (await this.handleCallback('onModelErrorCallback')) as
      | LlmResponse
      | undefined;
  }

  override async beforeContextCompaction(_params: {
    invocationContext: InvocationContext;
    trigger: ContextCompactionTrigger;
  }): Promise<void> {
    await this.handleCallback('beforeContextCompaction');
  }

  override async afterContextCompaction(_params: {
    invocationContext: InvocationContext;
    trigger: ContextCompactionTrigger;
  }): Promise<void> {
    await this.handleCallback('afterContextCompaction');
  }
}

describe('PluginManager', () => {
  let service: PluginManager;
  let plugin1: TestPlugin;
  let plugin2: TestPlugin;
  const mockInvocationContext = {} as InvocationContext;
  const mockUserMessage = {} as Content;
  const mockCallbackContext = {} as Context;
  const mockAgent = {} as BaseAgent;
  const mockTool = {} as BaseTool;
  const mockToolContext = {} as Context;
  const mockLlmRequest = {} as LlmRequest;
  const mockLlmResponse = {} as LlmResponse;
  const mockEvent = {} as Event;
  const mockError = new Error('mock error');

  beforeEach(() => {
    service = new PluginManager();
    plugin1 = new TestPlugin('plugin1');
    plugin2 = new TestPlugin('plugin2');
  });

  it('should register and get a plugin', () => {
    service.registerPlugin(plugin1);
    expect(service.getPlugin('plugin1')).toBe(plugin1);
  });

  it('should throw an error when registering a duplicate plugin object', () => {
    service.registerPlugin(plugin1);
    expect(() => service.registerPlugin(plugin1)).toThrowError(
      /Plugin 'plugin1' already registered/,
    );
  });

  it('should throw an error when registering a duplicate plugin name', () => {
    service.registerPlugin(plugin1);
    const plugin1Duplicate = new TestPlugin('plugin1');
    expect(() => service.registerPlugin(plugin1Duplicate)).toThrowError(
      /Plugin with name 'plugin1' already registered/,
    );
  });

  it('should stop subsequent plugins if early exit occurs', async () => {
    const mockResponse = {} as Content;
    plugin1.returnValues['beforeRunCallback'] = mockResponse;
    service.registerPlugin(plugin1);
    service.registerPlugin(plugin2);

    const result = await service.runBeforeRunCallback({
      invocationContext: mockInvocationContext,
    });

    expect(result).toBe(mockResponse);
    expect(plugin1.callLog).toContain('beforeRunCallback');
    expect(plugin2.callLog).not.toContain('beforeRunCallback');
  });

  it('should call all plugins if no plugin returns a value', async () => {
    service.registerPlugin(plugin1);
    service.registerPlugin(plugin2);

    const result = await service.runBeforeRunCallback({
      invocationContext: mockInvocationContext,
    });

    expect(result).toBeUndefined();
    expect(plugin1.callLog).toContain('beforeRunCallback');
    expect(plugin2.callLog).toContain('beforeRunCallback');
  });

  it('should wrap plugin exception in a runtime error', async () => {
    const originalException = new Error(
      'Something went wrong inside the plugin!',
    );
    plugin1.exceptionsToRaise['beforeRunCallback'] = originalException;
    service.registerPlugin(plugin1);

    try {
      await service.runBeforeRunCallback({
        invocationContext: mockInvocationContext,
      });
    } catch (e) {
      expect((e as Error).message).toContain(
        "Error in plugin 'plugin1' during 'beforeRunCallback' callback",
      );
    }
  });

  it('should support all callbacks', async () => {
    service.registerPlugin(plugin1);

    await service.runOnUserMessageCallback({
      userMessage: mockUserMessage,
      invocationContext: mockInvocationContext,
    });
    await service.runBeforeRunCallback({
      invocationContext: mockInvocationContext,
    });
    await service.runAfterRunCallback({
      invocationContext: mockInvocationContext,
    });
    await service.runOnEventCallback({
      invocationContext: mockInvocationContext,
      event: mockEvent,
    });
    await service.runBeforeAgentCallback({
      agent: mockAgent,
      callbackContext: mockCallbackContext,
    });
    await service.runAfterAgentCallback({
      agent: mockAgent,
      callbackContext: mockCallbackContext,
    });
    await service.runBeforeToolCallback({
      tool: mockTool,
      toolArgs: {},
      toolContext: mockToolContext,
    });
    await service.runAfterToolCallback({
      tool: mockTool,
      toolArgs: {},
      toolContext: mockToolContext,
      result: {},
    });
    await service.runOnToolErrorCallback({
      tool: mockTool,
      toolArgs: {},
      toolContext: mockToolContext,
      error: mockError,
    });
    await service.runBeforeModelCallback({
      callbackContext: mockCallbackContext,
      llmRequest: mockLlmRequest,
    });
    await service.runAfterModelCallback({
      callbackContext: mockCallbackContext,
      llmResponse: mockLlmResponse,
    });
    await service.runOnModelErrorCallback({
      callbackContext: mockCallbackContext,
      llmRequest: mockLlmRequest,
      error: mockError,
    });
    await service.runBeforeContextCompaction({
      invocationContext: mockInvocationContext,
      trigger: ContextCompactionTrigger.Auto,
    });
    await service.runAfterContextCompaction({
      invocationContext: mockInvocationContext,
      trigger: ContextCompactionTrigger.Auto,
    });

    const expectedCallbacks: PluginCallbackName[] = [
      'onUserMessageCallback',
      'beforeRunCallback',
      'afterRunCallback',
      'onEventCallback',
      'beforeAgentCallback',
      'afterAgentCallback',
      'beforeToolCallback',
      'afterToolCallback',
      'onToolErrorCallback',
      'beforeModelCallback',
      'afterModelCallback',
      'onModelErrorCallback',
      'beforeContextCompaction',
      'afterContextCompaction',
    ];
    expect(plugin1.callLog.sort()).toEqual(expectedCallbacks.sort());
  });
});

class ClosablePlugin extends BasePlugin {
  closeCount = 0;

  constructor(
    name: string,
    private readonly closeLog: string[],
    private readonly failure?: Error,
  ) {
    super(name);
  }

  override async close(): Promise<void> {
    this.closeCount++;
    this.closeLog.push(this.name);
    if (this.failure) {
      throw this.failure;
    }
  }
}

describe('PluginManager.close', () => {
  it('should close every registered plugin in registration order', async () => {
    const closeLog: string[] = [];
    const manager = new PluginManager([
      new ClosablePlugin('plugin1', closeLog),
      new ClosablePlugin('plugin2', closeLog),
      new ClosablePlugin('plugin3', closeLog),
    ]);

    await manager.close();

    expect(closeLog).toEqual(['plugin1', 'plugin2', 'plugin3']);
  });

  it('should resolve for a manager with no plugins', async () => {
    await expect(new PluginManager().close()).resolves.toBeUndefined();
  });

  it('should close the remaining plugins and aggregate the failures', async () => {
    const closeLog: string[] = [];
    const firstFailure = new Error('first boom');
    const secondFailure = new Error('second boom');
    const healthy = new ClosablePlugin('plugin_good', closeLog);
    const manager = new PluginManager([
      new ClosablePlugin('plugin_bad1', closeLog, firstFailure),
      new ClosablePlugin('plugin_bad2', closeLog, secondFailure),
      healthy,
    ]);

    const error = await manager.close().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      firstFailure,
      secondFailure,
    ]);
    expect((error as AggregateError).message).toEqual(
      "Failed to close plugins: 'plugin_bad1': Error, 'plugin_bad2': Error",
    );
    expect(healthy.closeCount).toEqual(1);
    expect(closeLog).toEqual(['plugin_bad1', 'plugin_bad2', 'plugin_good']);
  });
});

/** A promise together with the handles that settle it from a test. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

/** A plugin whose `close()` finishes only when the test settles its gate. */
class GatedClosePlugin extends BasePlugin {
  closeCount = 0;

  constructor(
    name: string,
    private readonly gate: Promise<void>,
  ) {
    super(name);
  }

  override async close(): Promise<void> {
    this.closeCount++;
    await this.gate;
  }
}

/** A plugin whose `close()` spans a real timer, so concurrency is observable. */
class DelayedClosePlugin extends BasePlugin {
  constructor(
    name: string,
    private readonly closeLog: string[],
    private readonly delayMs: number,
  ) {
    super(name);
  }

  override async close(): Promise<void> {
    this.closeLog.push(`${this.name}:start`);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.closeLog.push(`${this.name}:end`);
  }
}

/** A plugin that rejects with a value that is not an `Error`. */
class NonErrorClosePlugin extends BasePlugin {
  override async close(): Promise<void> {
    throw 'plain string failure';
  }
}

const SHORT_CLOSE_TIMEOUT_MS = 20;

describe('PluginManager.close timeout', () => {
  const gates: Deferred[] = [];

  function createGatedPlugin(name: string): GatedClosePlugin {
    const gate = createDeferred();
    gates.push(gate);
    return new GatedClosePlugin(name, gate.promise);
  }

  afterEach(() => {
    // Release every hung close so no worker is held open past its test.
    for (const gate of gates.splice(0)) {
      gate.resolve();
    }
  });

  it('should close the later plugins when an earlier one hangs past its budget', async () => {
    const closeLog: string[] = [];
    const hangs = createGatedPlugin('hangs');
    const healthy = new ClosablePlugin('healthy', closeLog);
    const manager = new PluginManager([hangs, healthy], SHORT_CLOSE_TIMEOUT_MS);

    const error = await manager.close().catch((e: unknown) => e);

    if (!(error instanceof AggregateError)) {
      expect.fail(`expected an AggregateError, got ${String(error)}`);
    }
    expect(error.errors).toHaveLength(1);
    expect(healthy.closeCount).toEqual(1);
    expect(closeLog).toEqual(['healthy']);
  });

  it('should report a plugin that overruns its budget as a timeout', async () => {
    const manager = new PluginManager(
      [createGatedPlugin('slow')],
      SHORT_CLOSE_TIMEOUT_MS,
    );

    const error = await manager.close().catch((e: unknown) => e);

    if (!(error instanceof AggregateError)) {
      expect.fail(`expected an AggregateError, got ${String(error)}`);
    }
    expect(error.message).toEqual(
      "Failed to close plugins: 'slow': PluginCloseTimeoutError",
    );
    const [cause] = error.errors;
    if (!isPluginCloseTimeoutError(cause)) {
      expect.fail(`expected a timeout error, got ${String(cause)}`);
    }
    expect(cause.pluginName).toEqual('slow');
    expect(cause.timeoutMs).toEqual(SHORT_CLOSE_TIMEOUT_MS);
    expect(cause.message).toEqual(
      `Plugin 'slow' did not close within ${SHORT_CLOSE_TIMEOUT_MS} ms.`,
    );
  });

  it('should not emit an unhandled rejection when an abandoned close later rejects', async () => {
    const gate = createDeferred();
    const manager = new PluginManager(
      [new GatedClosePlugin('slow', gate.promise)],
      SHORT_CLOSE_TIMEOUT_MS,
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(manager.close()).rejects.toBeInstanceOf(AggregateError);
      gate.reject(new Error('late boom'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it('should close plugins one at a time rather than concurrently', async () => {
    const closeLog: string[] = [];
    const manager = new PluginManager([
      new DelayedClosePlugin('p1', closeLog, 30),
      new DelayedClosePlugin('p2', closeLog, 20),
      new DelayedClosePlugin('p3', closeLog, 10),
    ]);

    await manager.close();

    expect(closeLog).toEqual([
      'p1:start',
      'p1:end',
      'p2:start',
      'p2:end',
      'p3:start',
      'p3:end',
    ]);
  });

  it('should name every failing plugin and its error type', async () => {
    const closeLog: string[] = [];
    const firstFailure = new TypeError('bad type');
    const thirdFailure = new RangeError('bad range');
    const manager = new PluginManager([
      new ClosablePlugin('plugin1', closeLog, firstFailure),
      new ClosablePlugin('plugin2', closeLog),
      new ClosablePlugin('plugin3', closeLog, thirdFailure),
    ]);

    const error = await manager.close().catch((e: unknown) => e);

    if (!(error instanceof AggregateError)) {
      expect.fail(`expected an AggregateError, got ${String(error)}`);
    }
    expect(error.message).toEqual(
      "Failed to close plugins: 'plugin1': TypeError, 'plugin3': RangeError",
    );
    expect(error.errors).toEqual([firstFailure, thirdFailure]);
    expect(closeLog).toEqual(['plugin1', 'plugin2', 'plugin3']);
  });

  it('should wrap a rejection that is not an Error', async () => {
    const manager = new PluginManager([new NonErrorClosePlugin('rude')]);

    const error = await manager.close().catch((e: unknown) => e);

    if (!(error instanceof AggregateError)) {
      expect.fail(`expected an AggregateError, got ${String(error)}`);
    }
    expect(error.message).toEqual("Failed to close plugins: 'rude': Error");
    const [cause] = error.errors;
    if (!(cause instanceof Error)) {
      expect.fail(`expected an Error, got ${String(cause)}`);
    }
    expect(cause.message).toEqual('plain string failure');
  });

  it('should log a timeout at warn and any other failure at error', async () => {
    const closeLog: string[] = [];
    const manager = new PluginManager(
      [
        createGatedPlugin('slow'),
        new ClosablePlugin('broken', closeLog, new Error('boom')),
      ],
      SHORT_CLOSE_TIMEOUT_MS,
    );
    const warnCalls: string[] = [];
    const errorCalls: string[] = [];
    setLogger({
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => {
        warnCalls.push(args.map((a) => String(a)).join(' '));
      },
      error: (...args: unknown[]) => {
        errorCalls.push(args.map((a) => String(a)).join(' '));
      },
    });

    try {
      await expect(manager.close()).rejects.toBeInstanceOf(AggregateError);
    } finally {
      resetLogger();
    }

    expect(warnCalls).toEqual([
      `Failed to close plugin 'slow': Plugin 'slow' did not close within ${SHORT_CLOSE_TIMEOUT_MS} ms.`,
    ]);
    expect(errorCalls).toEqual(["Failed to close plugin 'broken': boom"]);
  });

  it('should keep the plugins registered and re-close them on a second call', async () => {
    const closeLog: string[] = [];
    const plugin = new ClosablePlugin('plugin1', closeLog);
    const manager = new PluginManager([plugin]);

    await manager.close();
    await manager.close();

    expect(plugin.closeCount).toEqual(2);
    expect(manager.getPlugin('plugin1')).toBe(plugin);
  });
});
