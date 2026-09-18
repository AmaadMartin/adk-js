/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LocalEvalSampler: scoring a candidate agent against a real eval set.
 *
 * The sampler runs ADK's own `LocalEvalService` over the eval cases of a named
 * eval set, and reports 1.0 for every case that passed. This sample seeds an
 * `InMemoryEvalSetsManager` with two eval cases, gives the candidate a scripted
 * model, and scores it with a metric registered in the sample itself, so the
 * whole run is offline and needs no credentials.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/optimization/local_eval_sampler/agent.ts
 */

import {
  BaseLlm,
  BaseLlmConnection,
  EvalStatus,
  EvaluationResult,
  Evaluator,
  InMemoryEvalSetsManager,
  Invocation,
  LlmAgent,
  LlmResponse,
  LocalEvalSampler,
  MetricEvaluatorRegistry,
  node,
  NodeContext,
  Sampler,
  Workflow,
} from '@google/adk';

const APP_NAME = 'support_app';
const EVAL_SET_ID = 'greetings';
const METRIC_NAME = 'reply_is_polite';

/** The words the sample's metric rewards. */
const POLITE_WORDS = ['please', 'thanks', 'happy to help'];

/** A model that replays one fixed reply, so the sample makes no API call. */
class ScriptedLlm extends BaseLlm {
  constructor(private readonly reply: string) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: this.reply}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live connections.');
  }
}

/** Passes an invocation whose reply contains a polite word. */
class PolitenessEvaluator implements Evaluator {
  evaluateInvocations(actualInvocations: Invocation[]): EvaluationResult {
    const perInvocationResults = actualInvocations.map((actualInvocation) => {
      const reply = (actualInvocation.finalResponse?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('')
        .toLowerCase();
      const polite = POLITE_WORDS.some((word) => reply.includes(word));
      return {
        actualInvocation,
        score: polite ? 1 : 0,
        evalStatus: polite ? EvalStatus.PASSED : EvalStatus.FAILED,
      };
    });
    const passed = perInvocationResults.every(
      (result) => result.evalStatus === EvalStatus.PASSED,
    );
    return {
      overallScore: passed ? 1 : 0,
      overallEvalStatus: passed ? EvalStatus.PASSED : EvalStatus.FAILED,
      perInvocationResults,
    };
  }
}

/** Seeds one eval set with two single-turn eval cases. */
async function createEvalSetsManager(): Promise<InMemoryEvalSetsManager> {
  const evalSetsManager = new InMemoryEvalSetsManager();
  await evalSetsManager.createEvalSet(APP_NAME, EVAL_SET_ID);
  for (const evalId of ['greeting', 'farewell']) {
    await evalSetsManager.addEvalCase(APP_NAME, EVAL_SET_ID, {
      evalId,
      conversation: [
        {
          userContent: {role: 'user', parts: [{text: `say ${evalId}`}]},
          finalResponse: {role: 'model', parts: [{text: 'anything'}]},
        },
      ],
    });
  }
  return evalSetsManager;
}

const scoreCandidates = node(
  async (_ctx: NodeContext) => {
    const metricEvaluatorRegistry = new MetricEvaluatorRegistry();
    metricEvaluatorRegistry.registerEvaluator(
      METRIC_NAME,
      () => new PolitenessEvaluator(),
    );

    const sampler = await LocalEvalSampler.create({
      config: {
        evalConfig: {criteria: {[METRIC_NAME]: 0.5}},
        appName: APP_NAME,
        trainEvalSet: EVAL_SET_ID,
      },
      evalSetsManager: await createEvalSetsManager(),
      metricEvaluatorRegistry,
    });

    const candidates = {
      'polite': 'Happy to help with that.',
      'blunt': 'Done.',
    };
    const lines: string[] = [];
    for (const [name, reply] of Object.entries(candidates)) {
      const {scores} = await sampler.sampleAndScore({
        candidate: new LlmAgent({name, model: new ScriptedLlm(reply)}),
        exampleSet: Sampler.TRAIN_SET,
      });
      lines.push(`${name}: ${JSON.stringify(scores)}`);
    }
    return lines.join('\n');
  },
  {name: 'score_candidates'},
);

export const rootAgent = new Workflow({
  name: 'local_eval_sampler_workflow',
  edges: [['START', scoreCandidates]],
});
