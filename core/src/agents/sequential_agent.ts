/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Event} from '../events/event.js';
import {FunctionTool} from '../tools/function_tool.js';

import {deprecated} from '../utils/deprecated.js';
import {logger} from '../utils/logger.js';
import {BaseAgent, BaseAgentConfig, BaseAgentState} from './base_agent.js';
import {appendInstruction} from './instructions.js';
import {InvocationContext} from './invocation_context.js';
import {isLlmAgent} from './llm_agent.js';
import {ReadonlyContext} from './readonly_context.js';

const TASK_COMPLETED_TOOL_NAME = 'task_completed';

const COMPLETION_INSTRUCTION = `If you finished the user's request according to its description, call the ${
  TASK_COMPLETED_TOOL_NAME
} function to exit so the next agents can take over. When calling this function, do not generate any text other than the function call.`;

/**
 * The key {@link SequentialAgentState} is persisted under.
 *
 * Snake case, because the payload lands verbatim in the session store: the
 * event case transform preserves the keys inside `actions.agent_state`. A
 * camelCase key would make a checkpoint written by adk-python unreadable here.
 */
const CURRENT_SUB_AGENT_KEY = 'current_sub_agent';

/**
 * The configuration options for creating a {@link SequentialAgent}.
 *
 * Mirrors adk-python `SequentialAgentConfig`. A `SequentialAgent` adds no
 * options of its own, so this is an alias rather than an extension.
 */
export type SequentialAgentConfig = BaseAgentConfig;

/**
 * The resumption checkpoint of a {@link SequentialAgent}.
 *
 * Mirrors adk-python `SequentialAgentState`.
 */
export type SequentialAgentState = {
  /**
   * The name of the sub-agent to run next. Empty once the whole sequence has
   * finished.
   */
  currentSubAgent: string;
};

/**
 * Reads a persisted checkpoint into a {@link SequentialAgentState}.
 *
 * Rejects an unknown key and a non-string value, matching the pydantic model
 * adk-python validates against. A corrupt checkpoint fails loudly instead of
 * silently restarting the pipeline.
 *
 * @param raw The persisted record.
 * @returns The parsed state.
 * @throws If the record carries an unknown key or a non-string sub-agent name.
 */
function parseSequentialAgentState(raw: BaseAgentState): SequentialAgentState {
  for (const key of Object.keys(raw)) {
    if (key !== CURRENT_SUB_AGENT_KEY) {
      throw new Error(
        `Invalid SequentialAgent state: unexpected field "${key}".`,
      );
    }
  }
  const currentSubAgent = raw[CURRENT_SUB_AGENT_KEY] ?? '';
  if (typeof currentSubAgent !== 'string') {
    throw new Error(
      `Invalid SequentialAgent state: "${CURRENT_SUB_AGENT_KEY}" must be a ` +
        `string, got ${typeof currentSubAgent}.`,
    );
  }
  return {currentSubAgent};
}

/**
 * Returns the index of the sub-agent to start from.
 *
 * No checkpoint starts at the beginning. An empty name means the sequence
 * already finished, so nothing is left to run. A name that no longer matches a
 * sub-agent restarts the sequence, matching adk-python.
 *
 * @param subAgents The sub-agents of the sequential agent.
 * @param agentState The checkpoint to resume from, if there is one.
 * @returns The index to start the sub-agent loop at.
 */
function getStartIndex(
  subAgents: BaseAgent[],
  agentState: SequentialAgentState | undefined,
): number {
  if (!agentState) {
    return 0;
  }
  if (!agentState.currentSubAgent) {
    return subAgents.length;
  }
  const index = subAgents.findIndex(
    (subAgent) => subAgent.name === agentState.currentSubAgent,
  );
  if (index === -1) {
    logger.warn(
      `Sub-agent ${agentState.currentSubAgent} was removed so the agent name ` +
        `is not found. Restarting from the beginning.`,
    );
    return 0;
  }
  return index;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all SequentialAgent instances.
 */
const SEQUENTIAL_AGENT_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.sequentialAgent',
);

/**
 * Type guard to check if an object is an instance of SequentialAgent.
 * @param obj The object to check.
 * @returns True if the object is an instance of SequentialAgent, false otherwise.
 */
export function isSequentialAgent(obj: unknown): obj is SequentialAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    SEQUENTIAL_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[SEQUENTIAL_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A shell agent that runs its sub-agents in a sequential order.
 *
 * In a resumable app the agent records which sub-agent it is about to run and
 * emits a checkpoint event carrying it, so a later invocation resumes at that
 * sub-agent instead of re-running the whole sequence. In a non-resumable app
 * the event stream is only the sub-agents' own events.
 *
 * @deprecated Use `Workflow` instead, which expresses the same ordering as a
 * graph and adds routing, retries, HITL and resumability. This class will be
 * removed in a future version. Note that a `Workflow` cannot yet be an
 * `LlmAgent` sub-agent.
 */
@deprecated(
  'SequentialAgent is deprecated in favor of Workflow and will be removed in a' +
    ' future version. Workflow cannot yet be used as an LlmAgent sub-agent.',
)
export class SequentialAgent extends BaseAgent<SequentialAgentConfig> {
  /**
   * A unique symbol to identify ADK sequential agent class.
   */
  readonly [SEQUENTIAL_AGENT_SIGNATURE_SYMBOL] = true;

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    if (this.subAgents.length === 0) {
      return;
    }

    const agentState = this.loadAgentState(context, parseSequentialAgentState);
    const startIndex = getStartIndex(this.subAgents, agentState);

    let pauseInvocation = false;
    let resumingSubAgent = agentState !== undefined;

    for (let i = startIndex; i < this.subAgents.length; i++) {
      const subAgent = this.subAgents[i];

      // Resuming into this sub-agent means its checkpoint event is already in
      // history, so emitting it again would duplicate it.
      if (!resumingSubAgent && context.isResumable) {
        context.setAgentState(this.name, {
          agentState: {[CURRENT_SUB_AGENT_KEY]: subAgent.name},
        });
        yield this.createAgentStateEvent(context);
      }

      for await (const event of subAgent.runAsync(context)) {
        yield event;
        if (context.shouldPauseInvocation(event)) {
          pauseInvocation = true;
        }
      }

      // Leaving without the end-of-agent event is what makes the next
      // invocation re-enter at this same sub-agent.
      if (pauseInvocation) {
        return;
      }

      resumingSubAgent = false;
    }

    if (context.isResumable) {
      context.setAgentState(this.name, {endOfAgent: true});
      yield this.createAgentStateEvent(context);
    }
  }

  /**
   * Implementation for live SequentialAgent.
   *
   * Compared to the non-live case, live agents process a continuous stream of
   * audio or video, so there is no way to tell if it's finished and should pass
   * to the next agent or not. So we introduce a task_completed() function so
   * the model can call this function to signal that it's finished the task and
   * we can move on to the next agent.
   *
   * @param context The invocation context of the agent.
   */
  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    if (this.subAgents.length === 0) {
      return;
    }

    for (const subAgent of this.subAgents) {
      if (isLlmAgent(subAgent)) {
        const agentTools = await subAgent.canonicalTools(
          new ReadonlyContext(context),
        );
        const taskCompletedToolAlreadyAdded = agentTools.some(
          (tool) => tool.name === TASK_COMPLETED_TOOL_NAME,
        );

        if (!taskCompletedToolAlreadyAdded) {
          subAgent.tools.push(
            new FunctionTool({
              name: TASK_COMPLETED_TOOL_NAME,
              description: `Signals that the model has successfully completed the user's question or task.`,
              execute: () => 'Task completion signaled.',
            }),
          );
          subAgent.instruction = appendInstruction(
            subAgent.instruction,
            COMPLETION_INSTRUCTION,
          );
        }
      }
    }

    for (const subAgent of this.subAgents) {
      for await (const event of subAgent.runLive(context)) {
        yield event;
      }
    }
  }
}
