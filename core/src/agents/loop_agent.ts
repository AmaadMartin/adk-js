/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

import {deprecated} from '../utils/deprecated.js';
import {logger} from '../utils/logger.js';
import {BaseAgent, BaseAgentConfig, BaseAgentState} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

/**
 * The configuration options for creating a loop agent.
 */
export interface LoopAgentConfig extends BaseAgentConfig {
  /**
   * The maximum number of iterations the loop agent will run.
   *
   * If not provided, the loop agent will run indefinitely.
   */
  maxIterations?: number;
}

/**
 * The resumption checkpoint of a {@link LoopAgent}, exactly as it is persisted
 * on `EventActions.agentState`.
 *
 * The field names are snake_case because they cross the language boundary: a
 * session written by adk-python must be resumable here, and the reverse.
 *
 * Mirrors adk-python `LoopAgentState`.
 */
export type LoopAgentState = {
  /** The name of the sub-agent the loop is about to run. */
  current_sub_agent: string;
  /** The number of complete passes the loop has already made. */
  times_looped: number;
};

/**
 * Reads a persisted record back into a {@link LoopAgentState}.
 *
 * Rejects a record it cannot read, rather than restarting the loop from a
 * checkpoint it half-understands. The defaults and the rejected fields match
 * the pydantic model adk-python validates the same snapshot against.
 *
 * @param raw The persisted record.
 * @return The parsed loop state.
 * @throws If a field has the wrong type, or is not part of the state.
 */
function parseLoopAgentState(raw: BaseAgentState): LoopAgentState {
  for (const key of Object.keys(raw)) {
    if (key !== 'current_sub_agent' && key !== 'times_looped') {
      throw new Error(`Invalid LoopAgent state: unexpected field "${key}".`);
    }
  }
  const currentSubAgent = raw['current_sub_agent'] ?? '';
  if (typeof currentSubAgent !== 'string') {
    throw new Error(
      `Invalid LoopAgent state: "current_sub_agent" must be a string, got ${typeof currentSubAgent}.`,
    );
  }
  const timesLooped = raw['times_looped'] ?? 0;
  if (typeof timesLooped !== 'number' || !Number.isInteger(timesLooped)) {
    throw new Error(
      `Invalid LoopAgent state: "times_looped" must be an integer, got ${String(timesLooped)}.`,
    );
  }
  return {current_sub_agent: currentSubAgent, times_looped: timesLooped};
}

/**
 * Resolves a checkpoint into the pass and the sub-agent the loop restarts at.
 *
 * A checkpoint naming a sub-agent that no longer exists restarts the pass from
 * its first sub-agent, matching adk-python `LoopAgent._get_start_state`.
 *
 * @param subAgents The loop's sub-agents, in order.
 * @param agentState The checkpoint to resume from, if there is one.
 * @return The number of completed passes and the index to restart at.
 */
function getStartState(
  subAgents: BaseAgent[],
  agentState: LoopAgentState | undefined,
): {timesLooped: number; startIndex: number} {
  if (!agentState) {
    return {timesLooped: 0, startIndex: 0};
  }
  let startIndex = 0;
  if (agentState.current_sub_agent) {
    startIndex = subAgents.findIndex(
      (subAgent) => subAgent.name === agentState.current_sub_agent,
    );
    if (startIndex === -1) {
      logger.warn(
        `Sub-agent ${agentState.current_sub_agent} was not found. Restarting from the beginning.`,
      );
      startIndex = 0;
    }
  }
  return {timesLooped: agentState.times_looped, startIndex};
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all LoopAgent instances.
 */
const LOOP_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.loopAgent');

/**
 * Type guard to check if an object is an instance of LoopAgent.
 * @param obj The object to check.
 * @returns True if the object is an instance of LoopAgent, false otherwise.
 */
export function isLoopAgent(obj: unknown): obj is LoopAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    LOOP_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[LOOP_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A shell agent that run its sub-agents in a loop.
 *
 * When sub-agent generates an event with escalate or max_iterations are
 * reached, the loop agent will stop.
 *
 * @deprecated Use `Workflow` instead, which expresses the same ordering as a
 * graph and adds routing, retries, HITL and resumability. This class will be
 * removed in a future version. Note that a `Workflow` cannot yet be an
 * `LlmAgent` sub-agent.
 */
@deprecated(
  'LoopAgent is deprecated in favor of Workflow and will be removed in a' +
    ' future version. Workflow cannot yet be used as an LlmAgent sub-agent.',
)
export class LoopAgent extends BaseAgent<LoopAgentConfig> {
  /**
   * A unique symbol to identify ADK loop agent class.
   */
  readonly [LOOP_AGENT_SIGNATURE_SYMBOL] = true;

  readonly maxIterations: number;

  constructor(config: LoopAgentConfig) {
    super(config);
    this.maxIterations = config.maxIterations ?? Number.MAX_SAFE_INTEGER;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Without this guard a loop with no sub-agents and no maxIterations spins
    // Number.MAX_SAFE_INTEGER times over an empty body.
    if (this.subAgents.length === 0) {
      return;
    }

    const agentState = this.loadAgentState(context, parseLoopAgentState);
    let resumingAtCurrentSubAgent = agentState !== undefined;
    let {timesLooped, startIndex} = getStartState(this.subAgents, agentState);

    let shouldExit = false;
    let pauseInvocation = false;

    while (
      timesLooped < this.maxIterations &&
      !shouldExit &&
      !pauseInvocation
    ) {
      for (let i = startIndex; i < this.subAgents.length; i++) {
        const subAgent = this.subAgents[i];

        // Resuming into this sub-agent means its checkpoint event is already in
        // history, so emitting it again would duplicate it.
        if (context.isResumable && !resumingAtCurrentSubAgent) {
          context.setAgentState(this.name, {
            agentState: {
              current_sub_agent: subAgent.name,
              times_looped: timesLooped,
            },
          });
          yield this.createAgentStateEvent(context);
        }
        resumingAtCurrentSubAgent = false;

        for await (const event of subAgent.runAsync(context)) {
          if (context.abortSignal?.aborted) {
            return;
          }

          yield event;

          if (event.actions.escalate) {
            shouldExit = true;
          }
          if (context.shouldPauseInvocation(event)) {
            pauseInvocation = true;
          }
        }

        if (shouldExit || pauseInvocation) {
          break;
        }
      }

      if (!pauseInvocation) {
        startIndex = 0;
        timesLooped++;
        context.resetSubAgentStates(this.name);
      }
    }

    if (pauseInvocation) {
      return;
    }

    if (context.isResumable) {
      context.setAgentState(this.name, {endOfAgent: true});
      yield this.createAgentStateEvent(context);
    }
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      for (const subAgent of this.subAgents) {
        for await (const event of subAgent.runLive(context)) {
          if (context.abortSignal?.aborted) {
            return;
          }

          yield event;

          if (event.actions?.escalate) {
            return;
          }
        }
      }
    }
  }
}
