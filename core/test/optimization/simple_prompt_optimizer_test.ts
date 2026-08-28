/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  LlmAgent,
  LLMRegistry,
  SimplePromptOptimizer,
  type BaseLlmConnection,
  type ExampleSet,
  type LlmRequest,
  type LlmResponse,
  type SampleAndScoreParams,
  type Sampler,
  type SimplePromptOptimizerConfig,
  type UnstructuredSamplingResult,
} from '@google/adk';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const FAKE_MODEL = 'fake-optimizer-model';
const DEFAULT_OPTIMIZER_MODEL = 'gemini-2.5-flash';
const TRAIN_IDS = ['t1', 't2', 't3', 't4', 't5'];
const VALIDATION_IDS = ['v1', 'v2'];
const INITIAL_INSTRUCTION = 'Initial Prompt';
const IMPROVED_INSTRUCTION = 'IMPROVED PROMPT';

/** Responses the fake optimizer model yields. Replaced by each test. */
let scriptedResponses: LlmResponse[] = [];

/** Requests the fake optimizer model received during a test. */
let modelRequests: LlmRequest[] = [];

/** A text-only stand-in for the model that rewrites the instruction. */
class FakeOptimizerLlm extends BaseLlm {
  static override readonly supportedModels = [FAKE_MODEL];

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    modelRequests.push(llmRequest);
    yield* scriptedResponses;
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('FakeOptimizerLlm has no live connection.');
  }
}

/** Builds a model response carrying one plain text part. */
function textResponse(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

/** Reads an agent's instruction, which the tests always set as a string. */
function instructionOf(agent: LlmAgent): string {
  const {instruction} = agent;
  if (typeof instruction !== 'string') {
    return expect.fail(`expected a string instruction on ${agent.name}`);
  }
  return instruction;
}

/** Scores a candidate from the instruction it carries. */
type ScoreInstruction = (instruction: string) => number;

/** Scores anything that mentions IMPROVED above the initial instruction. */
const scoreImprovedHigher: ScoreInstruction = (instruction) =>
  instruction.includes('IMPROVED') ? 0.9 : 0.5;

/** Scores every rewrite below the initial instruction. */
const scoreRewriteLower: ScoreInstruction = (instruction) =>
  instruction === INITIAL_INSTRUCTION ? 0.5 : 0.1;

/** Scores every candidate the same, so no candidate ever wins. */
const scoreEverythingEqually: ScoreInstruction = () => 0.5;

/** Scores every rewrite above the initial instruction. */
const scoreRewriteHigher: ScoreInstruction = (instruction) =>
  instruction === INITIAL_INSTRUCTION ? 0.1 : 0.9;

/** The arguments of one `sampleAndScore` call, exactly as the optimizer sent them. */
interface RecordedCall {
  instruction: string;
  exampleSet?: ExampleSet;
  batch?: string[];
  captureFullEvalData?: boolean;
}

/** A sampler that records every call and scores from the instruction. */
class RecordingSampler implements Sampler<UnstructuredSamplingResult> {
  readonly calls: RecordedCall[] = [];
  trainIdReads = 0;

  constructor(
    private readonly score: ScoreInstruction,
    private readonly trainIds: string[] = TRAIN_IDS,
  ) {}

  getTrainExampleIds(): string[] {
    this.trainIdReads++;
    return [...this.trainIds];
  }

  getValidationExampleIds(): string[] {
    return [...VALIDATION_IDS];
  }

  async sampleAndScore(
    params: SampleAndScoreParams,
  ): Promise<UnstructuredSamplingResult> {
    const instruction = instructionOf(params.candidate);
    this.calls.push({
      instruction,
      exampleSet: params.exampleSet,
      batch: params.batch,
      captureFullEvalData: params.captureFullEvalData,
    });

    const exampleSet = params.exampleSet ?? 'validation';
    const batch =
      params.batch ??
      (exampleSet === 'train' ? [...this.trainIds] : [...VALIDATION_IDS]);
    return {
      scores: Object.fromEntries(
        batch.map((uid) => [uid, this.score(instruction)]),
      ),
    };
  }

  trainCalls(): RecordedCall[] {
    return this.calls.filter((call) => call.exampleSet === 'train');
  }
}

/** A sampler that never produces a score, for the divide-by-zero path. */
class EmptyScoreSampler implements Sampler<UnstructuredSamplingResult> {
  getTrainExampleIds(): string[] {
    return [...TRAIN_IDS];
  }

  getValidationExampleIds(): string[] {
    return [...VALIDATION_IDS];
  }

  async sampleAndScore(): Promise<UnstructuredSamplingResult> {
    return {scores: {}};
  }
}

function newInitialAgent(): LlmAgent {
  return new LlmAgent({name: 'test_agent', instruction: INITIAL_INSTRUCTION});
}

function newOptimizer(
  config: SimplePromptOptimizerConfig = {},
): SimplePromptOptimizer {
  return new SimplePromptOptimizer({optimizerModel: FAKE_MODEL, ...config});
}

describe('SimplePromptOptimizer', () => {
  beforeAll(() => {
    LLMRegistry.register(FakeOptimizerLlm);
  });

  beforeEach(() => {
    scriptedResponses = [textResponse(IMPROVED_INSTRUCTION)];
    modelRequests = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the winning instruction and its validation score', async () => {
    const sampler = new RecordingSampler(scoreImprovedHigher);

    const result = await newOptimizer({
      numIterations: 2,
      batchSize: 2,
    }).optimize(newInitialAgent(), sampler);

    expect(result.optimizedAgents).toHaveLength(1);
    expect(instructionOf(result.optimizedAgents[0].optimizedAgent)).toBe(
      IMPROVED_INSTRUCTION,
    );
    expect(result.optimizedAgents[0].overallScore).toBe(0.9);
    expect(sampler.trainIdReads).toBe(1);
    expect(sampler.calls).toHaveLength(4);
    expect(modelRequests).toHaveLength(2);
  });

  it('sends the current score and instruction to the optimizer model', async () => {
    await newOptimizer({numIterations: 1, batchSize: 2}).optimize(
      newInitialAgent(),
      new RecordingSampler(scoreImprovedHigher),
    );

    const prompt = modelRequests[0].contents[0].parts?.[0].text;
    expect(prompt).toContain('average score of 0.50 on a set of');
    expect(prompt).toContain(
      `<current_prompt>\n${INITIAL_INSTRUCTION}\n</current_prompt>`,
    );
    expect(modelRequests[0].model).toBe(FAKE_MODEL);
  });

  it('keeps the initial agent when the candidate scores lower', async () => {
    const result = await newOptimizer({
      numIterations: 1,
      batchSize: 2,
    }).optimize(newInitialAgent(), new RecordingSampler(scoreRewriteLower));

    expect(instructionOf(result.optimizedAgents[0].optimizedAgent)).toBe(
      INITIAL_INSTRUCTION,
    );
  });

  it('discards a candidate that ties with the incumbent', async () => {
    const result = await newOptimizer({
      numIterations: 1,
      batchSize: 2,
    }).optimize(
      newInitialAgent(),
      new RecordingSampler(scoreEverythingEqually),
    );

    expect(instructionOf(result.optimizedAgents[0].optimizedAgent)).toBe(
      INITIAL_INSTRUCTION,
    );
  });

  it('scores an empty result set as zero', async () => {
    const result = await newOptimizer({
      numIterations: 1,
      batchSize: 2,
    }).optimize(newInitialAgent(), new EmptyScoreSampler());

    expect(result.optimizedAgents[0].overallScore).toBe(0);
  });

  it('caps the batch at the number of training examples', async () => {
    const config: SimplePromptOptimizerConfig = {
      optimizerModel: FAKE_MODEL,
      numIterations: 1,
      batchSize: 10,
    };
    const sampler = new RecordingSampler(scoreImprovedHigher, [
      't1',
      't2',
      't3',
    ]);

    await new SimplePromptOptimizer(config).optimize(
      newInitialAgent(),
      sampler,
    );

    expect(sampler.trainCalls()).toHaveLength(2);
    for (const call of sampler.trainCalls()) {
      expect(call.batch).toHaveLength(3);
    }
    expect(config.batchSize).toBe(10);
  });

  it('concatenates the text parts and skips the thought parts', async () => {
    scriptedResponses = [
      {
        content: {
          role: 'model',
          parts: [{text: 'internal reasoning', thought: true}, {text: 'PART '}],
        },
      },
      textResponse('ONE'),
    ];

    const result = await newOptimizer({
      numIterations: 1,
      batchSize: 2,
    }).optimize(newInitialAgent(), new RecordingSampler(scoreRewriteHigher));

    expect(instructionOf(result.optimizedAgents[0].optimizedAgent)).toBe(
      'PART ONE',
    );
  });

  it('skips a response with no content and one with no parts', async () => {
    scriptedResponses = [
      {},
      {content: {role: 'model'}},
      textResponse('ONLY TEXT'),
    ];

    const result = await newOptimizer({
      numIterations: 1,
      batchSize: 2,
    }).optimize(newInitialAgent(), new RecordingSampler(scoreRewriteHigher));

    expect(instructionOf(result.optimizedAgents[0].optimizedAgent)).toBe(
      'ONLY TEXT',
    );
  });

  it('leaves the initial agent untouched and returns a clone', async () => {
    const initialAgent = newInitialAgent();

    const result = await newOptimizer({
      numIterations: 1,
      batchSize: 2,
    }).optimize(initialAgent, new RecordingSampler(scoreImprovedHigher));

    expect(initialAgent.instruction).toBe(INITIAL_INSTRUCTION);
    expect(result.optimizedAgents[0].optimizedAgent).not.toBe(initialAgent);
  });

  it('validates over the whole validation set without a batch', async () => {
    const sampler = new RecordingSampler(scoreImprovedHigher);

    await newOptimizer({numIterations: 1, batchSize: 2}).optimize(
      newInitialAgent(),
      sampler,
    );

    const lastCall = sampler.calls[sampler.calls.length - 1];
    expect(lastCall.exampleSet).toBe('validation');
    expect(lastCall.batch).toBeUndefined();
  });

  it('asks for scores only while it searches', async () => {
    const sampler = new RecordingSampler(scoreImprovedHigher);

    await newOptimizer({numIterations: 1, batchSize: 2}).optimize(
      newInitialAgent(),
      sampler,
    );

    for (const call of sampler.trainCalls()) {
      expect(call.captureFullEvalData).toBe(false);
    }
  });

  it('rejects an unknown optimizer model from the constructor', () => {
    expect(
      () => new SimplePromptOptimizer({optimizerModel: 'no-such'}),
    ).toThrow('Model no-such not found.');
  });

  it('resolves the default optimizer model in the constructor', () => {
    const newLlm = vi
      .spyOn(LLMRegistry, 'newLlm')
      .mockReturnValue(new FakeOptimizerLlm({model: FAKE_MODEL}));

    expect(() => new SimplePromptOptimizer()).not.toThrow();
    expect(newLlm).toHaveBeenCalledWith(DEFAULT_OPTIMIZER_MODEL);
  });

  it('runs ten rounds over batches of five by default', async () => {
    const sampler = new RecordingSampler(scoreEverythingEqually);

    await newOptimizer().optimize(newInitialAgent(), sampler);

    expect(sampler.calls).toHaveLength(12);
    expect(modelRequests).toHaveLength(10);
    for (const call of sampler.trainCalls()) {
      expect(call.batch).toHaveLength(5);
    }
  });

  it('refuses an agent whose instruction is a provider', async () => {
    const sampler = new RecordingSampler(scoreImprovedHigher);
    const agent = new LlmAgent({
      name: 'provider_agent',
      instruction: () => 'resolved at run time',
    });

    await expect(newOptimizer().optimize(agent, sampler)).rejects.toThrow(
      'SimplePromptOptimizer requires a static string instruction; agent ' +
        '"provider_agent" uses an instruction provider, which cannot be ' +
        'resolved outside a live invocation.',
    );
    expect(sampler.trainIdReads).toBe(0);
    expect(sampler.calls).toHaveLength(0);
  });
});
