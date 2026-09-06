/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolset,
  FunctionTool,
  LlmAgent,
  node,
  ReadonlyContext,
  RunAsyncToolRequest,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';

class EchoTool extends BaseTool {
  constructor() {
    super({name: 'echo', description: 'echoes its input'});
  }

  async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    return {echoed: true};
  }
}

class SingleTool extends BaseToolset {
  constructor() {
    super([]);
  }

  async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return [new EchoTool()];
  }

  async close(): Promise<void> {}
}

/** A node the model may call, described so it can be wrapped as a tool. */
function describedNode() {
  return node(
    (_ctx: unknown, input: {topic: string}) => `done: ${input.topic}`,
    {
      name: 'research',
      description: 'researches a topic',
      inputSchema: z.object({topic: z.string()}),
    },
  );
}

describe('LlmAgent tool validation', () => {
  it('rejects an agent listed as a tool at construction', () => {
    const helper = new LlmAgent({name: 'helper'});

    expect(() => {
      new LlmAgent({name: 'parent', tools: [helper]});
    }).toThrow(
      "Agent 'helper' cannot be wrapped as a NodeTool. Agents should be " +
        'invoked as sub-agents.',
    );
  });

  it('rejects an agent pushed onto tools after construction', async () => {
    const agent = new LlmAgent({name: 'parent'});
    agent.tools.push(new LlmAgent({name: 'helper'}));

    await expect(agent.canonicalTools()).rejects.toThrow(
      /cannot be wrapped as a NodeTool/,
    );
  });

  it('rejects a node that has no description', () => {
    const undescribed = node(
      (_ctx: unknown, input: {topic: string}) => input.topic,
      {name: 'research', inputSchema: z.object({topic: z.string()})},
    );

    expect(() => {
      new LlmAgent({name: 'parent', tools: [undescribed]});
    }).toThrow(
      "Workflow/Node 'research' must have a description to be wrapped as a " +
        'tool.',
    );
  });

  it('wraps a described node as a tool', async () => {
    const agent = new LlmAgent({name: 'parent', tools: [describedNode()]});

    const tools = await agent.canonicalTools();

    expect(tools.map((tool) => tool.name)).toEqual(['research']);
  });

  it('leaves a plain tool untouched', async () => {
    const tool = new EchoTool();
    const agent = new LlmAgent({name: 'parent', tools: [tool]});

    expect(await agent.canonicalTools()).toEqual([tool]);
  });

  it('resolves a toolset', async () => {
    const agent = new LlmAgent({name: 'parent', tools: [new SingleTool()]});

    const tools = await agent.canonicalTools();

    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
  });

  it('accepts a function tool', async () => {
    const agent = new LlmAgent({
      name: 'parent',
      tools: [
        new FunctionTool({
          name: 'a_tool',
          description: 'a tool',
          parameters: z.object({}),
          execute: () => 'ok',
        }),
      ],
    });

    const tools = await agent.canonicalTools();

    expect(tools.map((tool) => tool.name)).toEqual(['a_tool']);
  });
});
