/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  BaseToolset,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const APP_NAME = 'close_test_app';

/** A plugin that counts how often the runner closed it. */
class CountingPlugin extends BasePlugin {
  closeCount = 0;

  constructor(
    name: string,
    private readonly behaviour: 'resolve' | 'throw' | 'hang' = 'resolve',
  ) {
    super(name);
  }

  override async close(): Promise<void> {
    this.closeCount++;
    if (this.behaviour === 'throw') {
      throw new Error(`${this.name} could not release its socket`);
    }
    if (this.behaviour === 'hang') {
      return new Promise<void>(() => {});
    }
  }
}

/** A toolset that counts how often the runner closed it. */
class CountingToolset extends BaseToolset {
  closeCount = 0;

  constructor() {
    super([]);
  }

  override async getTools(): Promise<BaseTool[]> {
    return [];
  }

  override async close(): Promise<void> {
    this.closeCount++;
  }
}

function createRunner(params: {
  plugins?: BasePlugin[];
  toolsets?: CountingToolset[];
  pluginCloseTimeoutSeconds?: number;
}): Runner {
  const child = new LlmAgent({
    name: 'child',
    model: 'gemini-2.5-flash',
    tools: params.toolsets ?? [],
  });
  const agent = new LlmAgent({
    name: 'root',
    model: 'gemini-2.5-flash',
    subAgents: [child],
  });
  return new Runner({
    appName: APP_NAME,
    agent,
    sessionService: new InMemorySessionService(),
    plugins: params.plugins,
    pluginCloseTimeoutSeconds: params.pluginCloseTimeoutSeconds,
  });
}

describe('Runner.close', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes each registered plugin exactly once', async () => {
    const first = new CountingPlugin('first');
    const second = new CountingPlugin('second');
    const runner = createRunner({plugins: [first, second]});

    await runner.close();

    expect(first.closeCount).toBe(1);
    expect(second.closeCount).toBe(1);
  });

  it('closes each plugin only once when called twice', async () => {
    const plugin = new CountingPlugin('once');
    const runner = createRunner({plugins: [plugin]});

    await runner.close();
    await runner.close();

    expect(plugin.closeCount).toBe(1);
  });

  it('closes the toolsets reachable through the agent tree', async () => {
    const toolset = new CountingToolset();
    const runner = createRunner({toolsets: [toolset]});

    await runner.close();

    expect(toolset.closeCount).toBe(1);
  });

  it('closes the toolsets even when a plugin fails to close', async () => {
    const toolset = new CountingToolset();
    const runner = createRunner({
      plugins: [new CountingPlugin('failing', 'throw')],
      toolsets: [toolset],
    });

    await expect(runner.close()).rejects.toThrow(
      "Failed to close plugins: 'failing'",
    );
    expect(toolset.closeCount).toBe(1);
  });

  it('defaults the plugin close timeout to five seconds', async () => {
    vi.useFakeTimers();
    const runner = createRunner({
      plugins: [new CountingPlugin('stuck', 'hang')],
    });

    const settled = runner.close().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4999);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;

    expect((error as AggregateError).errors[0].message).toBe(
      "Closing plugin 'stuck' timed out after 5s.",
    );
  });

  it('gives each plugin the configured close timeout', async () => {
    vi.useFakeTimers();
    const runner = createRunner({
      plugins: [new CountingPlugin('stuck', 'hang')],
      pluginCloseTimeoutSeconds: 10,
    });

    const settled = runner.close().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(9999);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;

    expect((error as AggregateError).errors[0].message).toBe(
      "Closing plugin 'stuck' timed out after 10s.",
    );
  });
});
