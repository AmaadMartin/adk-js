/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EventsCompactionConfig} from '../../apps/events_compaction_config.js';
import {BaseContextCompactor} from '../../context/base_context_compactor.js';
import {BaseSummarizer} from '../../context/summarizers/base_summarizer.js';
import {LlmSummarizer} from '../../context/summarizers/llm_summarizer.js';
import {TokenBasedContextCompactor} from '../../context/token_based_context_compactor.js';
import {Event} from '../../events/event.js';
import {LlmRequest} from '../../models/llm_request.js';
import {ContextCompactionTrigger} from '../../plugins/base_plugin.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * A processor that evaluates a set of compactors to optionally compact
 * the conversation history (events) prior to generating an LLM request.
 *
 * It evaluates each compactor in priority order. The first one that indicates
 * it should compact will perform the compaction and iteration stops.
 *
 * An agent that declares no compactors falls back to the compaction policy the
 * `App` declared, which the Runner puts on the invocation context.
 */
export class ContextCompactorRequestProcessor implements BaseLlmRequestProcessor {
  private compactors: BaseContextCompactor[];

  /**
   * @param compactors - Ordered list of compactors to evaluate; the first one
   *   that reports it should compact will perform the compaction.
   */
  constructor(compactors: BaseContextCompactor[]) {
    this.compactors = compactors;
  }

  /**
   * Evaluates compactors in priority order. The first compactor that indicates
   * it should compact will compact the session history, fire plugin hooks, and
   * yield any newly generated events. Iteration stops after one compaction.
   *
   * Falls back to the app-level compaction policy when the agent declared no
   * compactors of its own.
   *
   * @param invocationContext - The current invocation context.
   * @param _llmRequest - Unused; present to satisfy the {@link BaseLlmRequestProcessor} interface.
   */
  async *runAsync(
    invocationContext: InvocationContext,
    _llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    for (const compactor of compactorsFor(this.compactors, invocationContext)) {
      const shouldCompact = await Promise.resolve(
        compactor.shouldCompact(invocationContext),
      );
      if (shouldCompact) {
        const trigger = compactor.trigger ?? ContextCompactionTrigger.Auto;
        await invocationContext.pluginManager.runBeforeContextCompaction({
          invocationContext,
          trigger,
        });

        const oldEvents = new Set(invocationContext.session.events);
        await Promise.resolve(compactor.compact(invocationContext));

        await invocationContext.pluginManager.runAfterContextCompaction({
          invocationContext,
          trigger,
        });

        const newEvents = invocationContext.session.events.filter(
          (e) => !oldEvents.has(e),
        );
        for (const e of newEvents) {
          yield e;
        }
        return; // Stop after one compactor has compacted the history.
      }
    }
  }
}

/**
 * The compactors to evaluate: the agent's own, or the app-level policy when
 * the agent declared none.
 *
 * @param declared The compactors the agent was built with.
 * @param ctx The current invocation.
 * @returns The compactors to evaluate, in priority order.
 */
function compactorsFor(
  declared: BaseContextCompactor[],
  ctx: InvocationContext,
): BaseContextCompactor[] {
  if (declared.length > 0 || !ctx.eventsCompactionConfig) {
    return declared;
  }
  const derived = compactorFromConfig(ctx.eventsCompactionConfig, ctx);
  return derived ? [derived] : [];
}

/**
 * The compactor an app-level policy asks for.
 *
 * Only the token trigger maps onto a compactor `adk-js` has. A policy that
 * configures the sliding window alone is rejected when the `App` is built, so
 * reaching that case here means the policy was set on the invocation directly.
 *
 * @param config The app-level compaction policy.
 * @param ctx The current invocation, which supplies the default summarizer.
 * @returns The compactor, or `undefined` when the policy asks for none.
 */
function compactorFromConfig(
  config: EventsCompactionConfig,
  ctx: InvocationContext,
): BaseContextCompactor | undefined {
  const {tokenThreshold, eventRetentionSize} = config;
  if (tokenThreshold === undefined || eventRetentionSize === undefined) {
    return undefined;
  }
  const summarizer = config.summarizer ?? defaultSummarizer(ctx);
  if (!summarizer) {
    return undefined;
  }
  return new TokenBasedContextCompactor({
    tokenThreshold,
    eventRetentionSize,
    summarizer,
  });
}

/**
 * Summarizes with the running agent's own model, as `adk-python` does when a
 * compaction policy names no summarizer.
 *
 * @param ctx The current invocation.
 * @returns The summarizer, or `undefined` when no model is in play.
 */
function defaultSummarizer(ctx: InvocationContext): BaseSummarizer | undefined {
  const agent = ctx.agent;
  return isLlmAgent(agent)
    ? new LlmSummarizer({llm: agent.canonicalModel})
    : undefined;
}
