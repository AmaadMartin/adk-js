/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The behaviour adk-python's suite does not reach: the config defaults, the
 * missing-engine error, the reflection wiring, and the error paths.
 */

import {
  AGENT_PROMPT_NAME,
  AgentGepaAdapter,
  BaseLlm,
  GEPARootAgentPromptOptimizer,
  isAgentOptimizer,
  isSampler,
  LlmAgent,
  LLMRegistry,
  type BaseLlmConnection,
  type GepaEngine,
  type GepaOptimizeParams,
  type GEPARootAgentPromptOptimizerConfig,
  type GepaRunResult,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import {
  collectWarnings,
  FakeGepaEngine,
  onlyOptimizeCall,
  RecordingSampler,
  runResult,
} from './gepa_test_utils.js';

const TRAIN_IDS = ['train1', 'train2'];
const VALIDATION_IDS = ['val1', 'val2'];

/** The model name the fake reflection model claims. */
const FAKE_MODEL = 'fake-gepa-reflection';

/** Every request the fake reflection model received, across the file. */
const reflectionRequests: LlmRequest[] = [];

/** How many times the fake reflection model was constructed. */
let reflectionModelsBuilt = 0;

/** A registered model that answers a reflection request with fixed text. */
class FakeReflectionLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /fake-gepa-.*/,
  ];

  constructor(params: {model: string}) {
    super(params);
    reflectionModelsBuilt += 1;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    reflectionRequests.push(llmRequest);
    yield {
      content: {role: 'model', parts: [{text: 'Rewritten instruction'}]},
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('FakeReflectionLlm does not support live connections.');
  }
}

/** An engine that reflects a fixed number of times, then reports nothing. */
class ReflectingEngine implements GepaEngine {
  readonly reflections: string[] = [];

  constructor(private readonly rounds: number) {}

  async optimize(params: GepaOptimizeParams): Promise<GepaRunResult> {
    for (let round = 0; round < this.rounds; round++) {
      this.reflections.push(await params.reflectionLm('What went wrong?'));
    }
    return runResult([], []);
  }
}

function createAgent(): LlmAgent {
  return new LlmAgent({
    name: 'support_agent',
    instruction: 'Initial instruction',
  });
}

function createSampler(): RecordingSampler {
  return new RecordingSampler({
    trainIds: TRAIN_IDS,
    validationIds: VALIDATION_IDS,
    result: {scores: {}},
  });
}

function createAdapter(): AgentGepaAdapter {
  return new AgentGepaAdapter({
    initialAgent: createAgent(),
    sampler: createSampler(),
  });
}

/** Runs one optimization and returns the params the engine was given. */
async function optimizeWith(
  config: GEPARootAgentPromptOptimizerConfig = {},
): Promise<GepaOptimizeParams> {
  const engine = new FakeGepaEngine(runResult([], []));
  await new GEPARootAgentPromptOptimizer({...config, engine}).optimize({
    initialAgent: createAgent(),
    sampler: createSampler(),
  });
  return onlyOptimizeCall(engine);
}

/** Runs one reflection round and returns the request the model received. */
async function reflectOnce(
  config: GEPARootAgentPromptOptimizerConfig,
): Promise<LlmRequest> {
  reflectionRequests.length = 0;
  await new GEPARootAgentPromptOptimizer({
    ...config,
    engine: new ReflectingEngine(1),
  }).optimize({initialAgent: createAgent(), sampler: createSampler()});
  expect(reflectionRequests).toHaveLength(1);
  return reflectionRequests[0];
}

beforeAll(() => {
  LLMRegistry.register(FakeReflectionLlm);
});

describe('GEPARootAgentPromptOptimizer identity', () => {
  it('is recognized as an agent optimizer', () => {
    expect(isAgentOptimizer(new GEPARootAgentPromptOptimizer())).toBe(true);
    expect(isAgentOptimizer(createSampler())).toBe(false);
  });

  it('accepts a sampler the public type guard recognizes', () => {
    expect(isSampler(createSampler())).toBe(true);
    expect(isSampler(new GEPARootAgentPromptOptimizer())).toBe(false);
  });
});

describe('GEPARootAgentPromptOptimizer config', () => {
  it('defaults the optimizer model to gemini-2.5-flash', () => {
    const resolve = vi.spyOn(LLMRegistry, 'resolve');

    try {
      new GEPARootAgentPromptOptimizer();

      expect(resolve).toHaveBeenCalledWith('gemini-2.5-flash');
    } finally {
      resolve.mockRestore();
    }
  });

  it('passes the adk-python engine defaults through', async () => {
    const call = await optimizeWith();

    expect(call.maxMetricCalls).toBe(100);
    expect(call.reflectionMinibatchSize).toBe(3);
    expect(call.runDir).toBeUndefined();
  });

  it('asks the reflection model to think by default', async () => {
    const request = await reflectOnce({optimizerModel: FAKE_MODEL});

    expect(request.config).toEqual({
      thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
    });
  });

  it('replaces every default with the configured value', async () => {
    const call = await optimizeWith({
      optimizerModel: FAKE_MODEL,
      modelConfiguration: {temperature: 0.1},
      maxMetricCalls: 7,
      reflectionMinibatchSize: 2,
      runDir: '/tmp/gepa-run',
    });

    expect(call.maxMetricCalls).toBe(7);
    expect(call.reflectionMinibatchSize).toBe(2);
    expect(call.runDir).toBe('/tmp/gepa-run');
  });

  it('rejects an optimizer model no registered class serves', () => {
    expect(
      () =>
        new GEPARootAgentPromptOptimizer({optimizerModel: 'no-such-model-42'}),
    ).toThrow('Model no-such-model-42 not found.');
  });
});

describe('GEPARootAgentPromptOptimizer.optimize', () => {
  it('refuses to run without an engine and never calls the sampler', async () => {
    const sampler = createSampler();

    await expect(
      new GEPARootAgentPromptOptimizer().optimize({
        initialAgent: createAgent(),
        sampler,
      }),
    ).rejects.toThrow(
      'GEPARootAgentPromptOptimizer requires a GEPA engine, which ADK does ' +
        'not bundle.',
    );
    expect(sampler.calls).toHaveLength(0);
  });

  it('names the config field that supplies an engine', async () => {
    await expect(
      new GEPARootAgentPromptOptimizer().optimize({
        initialAgent: createAgent(),
        sampler: createSampler(),
      }),
    ).rejects.toThrow(/`config\.engine`/);
  });

  it('warns that it leaves sub-agent instructions alone', async () => {
    const initialAgent = new LlmAgent({
      name: 'root_agent',
      instruction: 'Initial instruction',
      subAgents: [new LlmAgent({name: 'child_agent'})],
    });
    const engine = new FakeGepaEngine(runResult([], []));

    const warnings = await collectWarnings(async () => {
      await new GEPARootAgentPromptOptimizer({engine}).optimize({
        initialAgent,
        sampler: createSampler(),
      });
    });

    expect(warnings).toContain(
      'The GEPARootAgentPromptOptimizer will not optimize prompts for ' +
        'sub-agents.',
    );
  });

  it('stays quiet when the two example sets are disjoint', async () => {
    const engine = new FakeGepaEngine(runResult([], []));

    const warnings = await collectWarnings(async () => {
      await new GEPARootAgentPromptOptimizer({engine}).optimize({
        initialAgent: createAgent(),
        sampler: createSampler(),
      });
    });

    expect(warnings).toEqual([]);
  });

  it('rejects an instruction provider it cannot resolve offline', async () => {
    const engine = new FakeGepaEngine(runResult([], []));

    await expect(
      new GEPARootAgentPromptOptimizer({engine}).optimize({
        initialAgent: new LlmAgent({
          name: 'support_agent',
          instruction: async () => 'Built per request.',
        }),
        sampler: createSampler(),
      }),
    ).rejects.toThrow(/static string/);
  });

  it('rejects an engine that scores only some of its candidates', async () => {
    const engine = new FakeGepaEngine(
      runResult(
        [{[AGENT_PROMPT_NAME]: 'a'}, {[AGENT_PROMPT_NAME]: 'b'}],
        [0.5],
      ),
    );

    await expect(
      new GEPARootAgentPromptOptimizer({engine}).optimize({
        initialAgent: createAgent(),
        sampler: createSampler(),
      }),
    ).rejects.toThrow(
      'GEPA reported 2 candidates and 1 validation scores; it must report ' +
        'one score per candidate.',
    );
  });

  it('gives the engine a reflection call that reaches the model', async () => {
    const engine = new ReflectingEngine(2);
    reflectionRequests.length = 0;
    const modelsBefore = reflectionModelsBuilt;

    await new GEPARootAgentPromptOptimizer({
      engine,
      optimizerModel: FAKE_MODEL,
      modelConfiguration: {temperature: 0.2},
    }).optimize({initialAgent: createAgent(), sampler: createSampler()});

    expect(engine.reflections).toEqual([
      'Rewritten instruction',
      'Rewritten instruction',
    ]);
    expect(reflectionRequests).toHaveLength(2);
    expect(reflectionRequests[0].model).toBe(FAKE_MODEL);
    expect(reflectionRequests[0].config).toEqual({temperature: 0.2});
    expect(reflectionRequests[0].contents).toEqual([
      {role: 'user', parts: [{text: 'What went wrong?'}]},
    ]);
    expect(reflectionModelsBuilt - modelsBefore).toBe(1);
  });
});

describe('AgentGepaAdapter batch routing', () => {
  it('routes an empty batch to the training set', async () => {
    const sampler = createSampler();
    const adapter = new AgentGepaAdapter({
      initialAgent: createAgent(),
      sampler,
    });

    await adapter.evaluate([], {[AGENT_PROMPT_NAME]: 'Prompt'});

    expect(sampler.calls[0].exampleSet).toBe('train');
  });

  it('rejects a batch that spans both example sets', async () => {
    await expect(
      createAdapter().evaluate(['train1', 'val1'], {
        [AGENT_PROMPT_NAME]: 'Prompt',
      }),
    ).rejects.toThrow('Invalid batch composition: train1,val1');
  });

  it('rejects a batch holding an unknown example id', async () => {
    await expect(
      createAdapter().evaluate(['nope'], {[AGENT_PROMPT_NAME]: 'Prompt'}),
    ).rejects.toThrow('Invalid batch composition: nope');
  });

  it('rejects a reflective dataset with fewer trajectories than scores', () => {
    expect(() =>
      createAdapter().makeReflectiveDataset(
        {[AGENT_PROMPT_NAME]: 'Prompt'},
        {outputs: [{}, {}], scores: [0.9, 0.1], trajectories: [{t: 1}]},
        ['component1'],
      ),
    ).toThrow(
      'GEPA reported 2 scores and 1 trajectories; a reflective dataset ' +
        'needs one trajectory per score.',
    );
  });

  it('rejects a reflective dataset with undefined trajectories', () => {
    expect(() =>
      createAdapter().makeReflectiveDataset(
        {[AGENT_PROMPT_NAME]: 'Prompt'},
        {outputs: [], scores: []},
        ['component1'],
      ),
    ).toThrow(
      'GEPA cannot build a reflective dataset without captured trajectories.',
    );
  });

  it('serves the same records to every requested component', () => {
    const dataset = createAdapter().makeReflectiveDataset(
      {[AGENT_PROMPT_NAME]: 'Prompt'},
      {outputs: [{}], scores: [0.5], trajectories: [{t: 1}]},
      ['one', 'two'],
    );

    expect(Object.keys(dataset)).toEqual(['one', 'two']);
    expect(dataset['one']).toEqual(dataset['two']);
  });
});
