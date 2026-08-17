/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  createSession,
  Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {MeterProvider} from '@opentelemetry/sdk-metrics';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow, FnNode} from '../workflow/test_helpers.js';
import {
  collectDataPoint,
  collectHistogram,
  installMeterProvider,
} from './test_helpers.js';

/** A model that replays a fixed script of responses, one per call. */
class ScriptedLlm extends BaseLlm {
  private callCount = 0;

  constructor(private readonly script: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const response = this.script[this.callCount++];
    if (!response) {
      throw new Error(
        `ScriptedLlm ran out of responses after ${this.script.length} calls.`,
      );
    }
    yield response;
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live connections.');
  }
}

/** An agent that runs its only sub-agent, so the sub-agent tallies its own calls. */
class DelegatingAgent extends BaseAgent {
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.subAgents[0].runAsync(context);
  }

  // eslint-disable-next-line require-yield -- runLive is unused here but BaseAgent declares it abstract.
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

const textResponse = (text: string): LlmResponse => ({
  content: {role: 'model', parts: [{text}]},
});

const toolCallResponse = (name: string): LlmResponse => ({
  content: {
    role: 'model',
    parts: [{functionCall: {id: `call-${name}`, name, args: {}}}],
  },
});

function createParentContext(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    agent,
    session: createSession({
      id: 'session-1',
      appName: 'app',
      userId: 'user',
      state: {},
      lastUpdateTime: Date.now(),
    }),
    pluginManager: new PluginManager(),
  });
}

async function drain(agent: BaseAgent): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(createParentContext(agent))) {
    events.push(event);
  }
  return events;
}

/** Returns each data point of a histogram keyed by its agent name. */
async function sumsByAgent(name: string): Promise<Map<string, number>> {
  const metric = await collectHistogram(name);
  const sums = new Map<string, number>();
  for (const dataPoint of metric.dataPoints) {
    sums.set(
      String(dataPoint.attributes['gen_ai.agent.name']),
      dataPoint.value.sum ?? 0,
    );
  }
  return sums;
}

describe('metric recording sites', () => {
  let provider: MeterProvider;

  beforeEach(() => {
    provider = installMeterProvider();
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it('records the duration and both call counts of a tool-calling agent', async () => {
    const tool = new FunctionTool({
      name: 'get_weather',
      description: 'reports the weather',
      parameters: z.object({}),
      execute: async () => ({weather: 'sunny'}),
    });
    const agent = new LlmAgent({
      name: 'weather_agent',
      model: new ScriptedLlm([
        toolCallResponse('get_weather'),
        textResponse('It is sunny.'),
      ]),
      tools: [tool],
    });

    await drain(agent);

    expect(
      (await collectDataPoint('gen_ai.invoke_agent.duration')).attributes,
    ).toEqual({'gen_ai.agent.name': 'weather_agent'});
    expect(
      (await collectDataPoint('gen_ai.invoke_agent.inference_calls')).value.sum,
    ).toBe(2);
    expect(
      (await collectDataPoint('gen_ai.invoke_agent.tool_calls')).value.sum,
    ).toBe(1);
    expect(
      (await collectDataPoint('gen_ai.execute_tool.duration')).attributes,
    ).toEqual({
      'gen_ai.agent.name': 'weather_agent',
      'gen_ai.tool.name': 'get_weather',
      'gen_ai.tool.type': 'FunctionTool',
    });
  });

  it('records zero calls for an agent that reached neither a model nor a tool', async () => {
    const agent = new LlmAgent({
      name: 'quiet_agent',
      model: new ScriptedLlm([textResponse('hi')]),
      beforeAgentCallback: [
        async () => ({role: 'model', parts: [{text: 'hi'}]}),
      ],
    });

    await drain(agent);

    expect(
      (await collectDataPoint('gen_ai.invoke_agent.inference_calls')).value,
    ).toMatchObject({count: 1, sum: 0});
    expect(
      (await collectDataPoint('gen_ai.invoke_agent.tool_calls')).value,
    ).toMatchObject({count: 1, sum: 0});
  });

  it('tallies a sub-agent tool call to the sub-agent, not to its parent', async () => {
    const tool = new FunctionTool({
      name: 'get_weather',
      description: 'reports the weather',
      parameters: z.object({}),
      execute: async () => ({weather: 'sunny'}),
    });
    const child = new LlmAgent({
      name: 'child_agent',
      model: new ScriptedLlm([
        toolCallResponse('get_weather'),
        textResponse('It is sunny.'),
      ]),
      tools: [tool],
    });
    const parent = new DelegatingAgent({
      name: 'parent_agent',
      subAgents: [child],
    });

    await drain(parent);

    const toolCalls = await sumsByAgent('gen_ai.invoke_agent.tool_calls');
    expect(toolCalls.get('child_agent')).toBe(1);
    expect(toolCalls.get('parent_agent')).toBe(0);
  });

  it('records a failing tool with its error type and still counts the call', async () => {
    const tool = new FunctionTool({
      name: 'broken_tool',
      description: 'always fails',
      parameters: z.object({}),
      execute: async () => {
        throw new RangeError('tool blew up');
      },
    });
    const agent = new LlmAgent({
      name: 'failing_agent',
      model: new ScriptedLlm([
        toolCallResponse('broken_tool'),
        textResponse('I could not do that.'),
      ]),
      tools: [tool],
    });

    await drain(agent);

    const dataPoint = await collectDataPoint('gen_ai.execute_tool.duration');
    expect(dataPoint.attributes).toEqual({
      'gen_ai.agent.name': 'failing_agent',
      'gen_ai.tool.name': 'broken_tool',
      'gen_ai.tool.type': 'FunctionTool',
      // FunctionTool re-raises a failing tool as a plain Error.
      'error.type': 'Error',
    });
    expect(
      (await collectDataPoint('gen_ai.invoke_agent.tool_calls')).value.sum,
    ).toBe(1);
  });

  it('records a root workflow without the nested flag', async () => {
    const workflow = new Workflow({
      name: 'root_workflow',
      edges: [['START', new FnNode('only', () => 'done')]],
    });

    await driveWorkflow(workflow);

    expect(
      (await collectDataPoint('gen_ai.invoke_workflow.duration')).attributes,
    ).toEqual({
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.workflow.name': 'root_workflow',
    });
  });

  it('flags a workflow nested inside another workflow', async () => {
    const inner = new Workflow({
      name: 'inner_workflow',
      edges: [['START', new FnNode('leaf', () => 'done')]],
    });
    const outer = new Workflow({
      name: 'outer_workflow',
      edges: [['START', inner]],
    });

    await driveWorkflow(outer);

    const metric = await collectHistogram('gen_ai.invoke_workflow.duration');
    const byName = new Map(
      metric.dataPoints.map((dataPoint) => [
        dataPoint.attributes['gen_ai.workflow.name'],
        dataPoint.attributes['gen_ai.workflow.nested'],
      ]),
    );
    expect(byName.get('outer_workflow')).toBeUndefined();
    expect(byName.get('inner_workflow')).toBe(true);
  });

  it('records a failing workflow with its error type and still raises', async () => {
    const workflow = new Workflow({
      name: 'broken_workflow',
      edges: [
        [
          'START',
          new FnNode('boom', () => {
            throw new RangeError('node blew up');
          }),
        ],
      ],
    });

    await expect(driveWorkflow(workflow)).rejects.toThrow();

    const dataPoint = await collectDataPoint('gen_ai.invoke_workflow.duration');
    expect(dataPoint.attributes['gen_ai.workflow.name']).toBe(
      'broken_workflow',
    );
    expect(dataPoint.attributes['error.type']).toBeDefined();
  });
});
