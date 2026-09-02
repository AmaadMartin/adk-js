/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  Event,
  InMemoryRunner,
  InvocationContext,
  isLoopAgent,
  LoopAgent,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {batchLoadYamlAgentConfig} from '../../src/conformance/yaml_agent_loader.js';
import {AgentRegistry} from '../../src/integration/agent_registry.js';
import {IntegrationRegistry} from '../../src/integration/integration_registry.js';

const APP_NAME = 'loop_agent_config_test';

/**
 * The run on which the sub-agent escalates, which stops a loop the config
 * failed to bound. It keeps a regression failing instead of hanging.
 */
const ESCALATE_ON_RUN = 3;

/** A sub-agent that records how many times the loop ran it. */
class CountingAgent extends BaseAgent {
  runs = 0;

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.runs++;
    yield createEvent({
      author: this.name,
      invocationId: context.invocationId,
      content: {role: 'model', parts: [{text: `pass ${this.runs}`}]},
      actions: {escalate: this.runs >= ESCALATE_ON_RUN},
    });
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(context);
  }
}

/**
 * Writes a LoopAgent config to `dir` and builds it the way the integration
 * runner does: through the real YAML loader and the real registry.
 */
async function buildLoopAgentFromYaml(
  dir: string,
  maxIterations: string,
): Promise<{loop: LoopAgent; worker: CountingAgent}> {
  await fs.writeFile(
    path.join(dir, 'root_agent.yaml'),
    [
      'agent_class: LoopAgent',
      'name: reviewer',
      'description: reviews a draft',
      `max_iterations: ${maxIterations}`,
      'sub_agents:',
      '  - config_path: worker.yaml',
      '',
    ].join('\n'),
  );

  const worker = new CountingAgent({name: 'worker', description: 'counts'});
  const registry = new AgentRegistry(new IntegrationRegistry());
  registry.registerAgent('worker', worker);
  for (const [name, config] of await batchLoadYamlAgentConfig(dir)) {
    registry.registerAgentConfig(name, config);
  }

  const loop = registry.getAgent('root_agent');
  if (!isLoopAgent(loop)) {
    expect.fail('the registry did not build a LoopAgent');
  }
  return {loop, worker};
}

/** Runs `loop` to completion and returns the events it produced. */
async function run(loop: LoopAgent): Promise<Event[]> {
  const runner = new InMemoryRunner({agent: loop, appName: APP_NAME});
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: 'user',
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'go'}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('a LoopAgent loaded from a YAML config', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-loop-config-'));
  });

  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true});
  });

  it('runs no passes when max_iterations is 0', async () => {
    const {loop, worker} = await buildLoopAgentFromYaml(dir, '0');

    const events = await run(loop);

    expect(loop.maxIterations).toBe(0);
    expect(worker.runs).toBe(0);
    expect(events).toEqual([]);
  });

  it('runs the sub-agent once per pass when max_iterations is set', async () => {
    const {loop, worker} = await buildLoopAgentFromYaml(dir, '2');

    const events = await run(loop);

    expect(loop.maxIterations).toBe(2);
    expect(worker.runs).toBe(2);
    expect(events.map((event) => event.author)).toEqual(['worker', 'worker']);
  });
});
