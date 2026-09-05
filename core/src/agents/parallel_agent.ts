/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

import {deprecated} from '../utils/deprecated.js';
import {logger} from '../utils/logger.js';
import {createSubBranch} from '../workflow/branch_path.js';
import {BaseAgent} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all ParallelAgent instances.
 */
const PARALLEL_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.parallelAgent');

/**
 * Type guard to check if an object is an instance of ParallelAgent.
 * @param obj The object to check.
 * @returns True if the object is an instance of ParallelAgent, false otherwise.
 */
export function isParallelAgent(obj: unknown): obj is ParallelAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    PARALLEL_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[PARALLEL_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A shell agent that runs its sub-agents in parallel on separate branches.
 *
 * This approach is beneficial for scenarios requiring multiple perspectives or
 * attempts on a single task, such as:
 *
 *  - Running different algorithms simultaneously.
 *  - Generating multiple responses for review by a subsequent evaluation agent.
 *
 * Only conversation history is isolated between branches: a sub-agent sees the
 * events that led to the fan-out and its own, but not those of a sibling.
 * Session state is shared by every branch, so branches writing the same key
 * leave only the value written last.
 *
 * @deprecated Use `Workflow` instead, which expresses the same ordering as a
 * graph and adds routing, retries, HITL and resumability. This class will be
 * removed in a future version. Note that a `Workflow` cannot yet be an
 * `LlmAgent` sub-agent.
 */
@deprecated(
  'ParallelAgent is deprecated in favor of Workflow and will be removed in a' +
    ' future version. Workflow cannot yet be used as an LlmAgent sub-agent.',
)
export class ParallelAgent extends BaseAgent {
  /**
   * A unique symbol to identify ADK parallel agent class.
   */
  readonly [PARALLEL_AGENT_SIGNATURE_SYMBOL] = true;

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    if (this.subAgents.length === 0) {
      return;
    }

    if (context.isResumable && context.agentStates[this.name] === undefined) {
      context.setAgentState(this.name, {agentState: {}});
      yield this.createAgentStateEvent(context);
    }

    const subAgentNames = new Set(this.subAgents.map(({name}) => name));
    const agentRuns = this.subAgents
      .filter((subAgent) => !context.endOfAgents[subAgent.name])
      .map((subAgent) =>
        subAgent.runAsync(createBranchCtxForSubAgent(this, subAgent, context)),
      );

    let escalated = false;
    let paused = false;
    // Breaking out closes the merge, which closes every branch still running.
    for await (const event of mergeAgentRuns(agentRuns)) {
      if (context.abortSignal?.aborted) {
        return;
      }

      yield event;

      paused ||= context.shouldPauseInvocation(event);
      if (asksThisAgentToExit(event, subAgentNames)) {
        escalated = true;
        break;
      }
    }

    if (paused) {
      return;
    }

    const allSubAgentsFinished = this.subAgents.every(
      (subAgent) => context.endOfAgents[subAgent.name],
    );
    if (context.isResumable && (escalated || allSubAgentsFinished)) {
      context.setAgentState(this.name, {endOfAgent: true});
      yield this.createAgentStateEvent(context);
    }
  }

  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    throw new Error('This is not supported yet for ParallelAgent.');
  }
}

/** One branch's run: the generator driving a single sub-agent. */
type AgentRun = AsyncGenerator<Event, void, void>;

/** The event a branch produced, or the end of that branch. */
interface BranchEvent {
  readonly index: number;
  readonly result: IteratorResult<Event, void>;
}

/**
 * Create isolated branch for every sub-agent.
 */
function createBranchCtxForSubAgent(
  agent: BaseAgent,
  subAgent: BaseAgent,
  originalContext: InvocationContext,
): InvocationContext {
  return originalContext.clone({
    branch: createSubBranch(originalContext.branch, {
      name: `${agent.name}.${subAgent.name}`,
    }),
  });
}

/**
 * Whether `event` asks this parallel agent to stop its remaining branches.
 *
 * An escalation ends the workflow that directly encloses the escalating agent,
 * and that workflow re-yields the event while it unwinds. Only an escalation a
 * direct sub-agent authored is therefore addressed to this agent.
 */
function asksThisAgentToExit(
  event: Event,
  subAgentNames: ReadonlySet<string>,
): boolean {
  const {author} = event;
  return (
    Boolean(event.actions.escalate) &&
    author !== undefined &&
    subAgentNames.has(author)
  );
}

/**
 * Closes every branch, so each sub-agent runs its own cleanup.
 *
 * A failure to close is logged rather than thrown: it must not mask the error
 * or the escalation that ended the fan-out.
 */
async function closeAgentRuns(agentRuns: readonly AgentRun[]): Promise<void> {
  const outcomes = await Promise.allSettled(
    agentRuns.map((agentRun) => agentRun.return()),
  );
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      logger.warn('Failed to close a parallel sub-agent run:', outcome.reason);
    }
  }
}

/**
 * Merges the events of every branch into one stream, in arrival order.
 *
 * A branch is asked for its next event only after the consumer has processed
 * the previous one, so at most one event per branch is ever in flight. The
 * merge stops at the first branch failure, and closes every branch on the way
 * out — including when the consumer stops reading.
 *
 * @param agentRuns The generator driving each sub-agent.
 *
 * @yield The next event from the merged generator.
 */
async function* mergeAgentRuns(
  agentRuns: readonly AgentRun[],
): AsyncGenerator<Event, void, void> {
  const pending = new Map<number, Promise<BranchEvent>>();

  try {
    for (let index = 0; index < agentRuns.length; index++) {
      pending.set(
        index,
        agentRuns[index].next().then((result) => ({index, result})),
      );
    }

    while (pending.size > 0) {
      // Promise.race attaches a rejection handler to every pending branch, so
      // a branch that fails while the consumer is busy is reported here, on
      // the next pass, rather than escaping as an unhandled rejection.
      const {index, result} = await Promise.race(pending.values());
      pending.delete(index);

      if (result.done) {
        continue;
      }

      yield result.value;

      pending.set(
        index,
        agentRuns[index].next().then((result) => ({index, result})),
      );
    }
  } finally {
    await closeAgentRuns(agentRuns);
  }
}
