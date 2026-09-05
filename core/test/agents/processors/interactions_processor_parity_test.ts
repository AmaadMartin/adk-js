/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python
 * `tests/unittests/flows/llm_flows/test_interactions_processor.py` at `main`
 * (30e0a2675689a5ac205becfbc2c7c4953ed87ef0). Each `it()` string keeps the
 * reference test name so the two suites stay greppable against each other.
 */

import {
  createEvent,
  createSession,
  Event,
  Gemini,
  getLogger,
  INTERACTIONS_REQUEST_PROCESSOR,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {findPreviousInteractionState} from '@google/adk/agents/processors/interactions_request_processor.js';
import {isEventInBranch} from '@google/adk/utils/branch_trie.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

const AGENT_NAME = 'test_agent';

function event(
  author: string,
  interactionId?: string,
  branch?: string,
  environmentId?: string,
): Event {
  return createEvent({
    invocationId: 'inv1',
    author,
    interactionId,
    branch,
    environmentId,
  });
}

function interactionsContext(
  events: Event[],
  branch?: string,
  agentName = AGENT_NAME,
): InvocationContext {
  const agent = new LlmAgent({
    name: agentName,
    model: new Gemini({
      model: 'gemini-2.5-flash',
      apiKey: 'dummy',
      useInteractionsApi: true,
    }),
  });

  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    branch,
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events,
    }),
    pluginManager: new PluginManager([]),
  });
}

async function runProcessor(
  invocationContext: InvocationContext,
): Promise<LlmRequest> {
  const llmRequest: LlmRequest = {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };

  for await (const _ of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    // The processor yields no events; drain the generator so it runs.
  }

  return llmRequest;
}

describe('interactions processor parity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_find_previous_interaction_id_empty_events', () => {
    const state = findPreviousInteractionState([], AGENT_NAME);

    expect(state.interactionId).toBeUndefined();
  });

  it('test_find_previous_interaction_id_user_only_events', () => {
    const state = findPreviousInteractionState(
      [event('user'), event('user')],
      AGENT_NAME,
    );

    expect(state.interactionId).toBeUndefined();
  });

  it('test_find_previous_interaction_id_no_interaction_id', () => {
    const state = findPreviousInteractionState(
      [event('user'), event(AGENT_NAME)],
      AGENT_NAME,
    );

    expect(state.interactionId).toBeUndefined();
  });

  it('test_find_previous_interaction_id_from_model_event', () => {
    const state = findPreviousInteractionState(
      [event('user'), event(AGENT_NAME, 'interaction_123')],
      AGENT_NAME,
    );

    expect(state.interactionId).toBe('interaction_123');
  });

  it('test_find_previous_interaction_id_returns_most_recent', () => {
    const state = findPreviousInteractionState(
      [
        event('user'),
        event(AGENT_NAME, 'interaction_first'),
        event('user'),
        event(AGENT_NAME, 'interaction_second'),
      ],
      AGENT_NAME,
    );

    expect(state.interactionId).toBe('interaction_second');
  });

  it('test_find_previous_interaction_id_skips_user_events', () => {
    const state = findPreviousInteractionState(
      [
        event(AGENT_NAME, 'interaction_model'),
        event('user', 'interaction_user'),
      ],
      AGENT_NAME,
    );

    expect(state.interactionId).toBe('interaction_model');
  });

  it('test_is_event_in_branch_no_branch', () => {
    expect(isEventInBranch(undefined, event('test'))).toBe(true);
    expect(
      isEventInBranch(undefined, event('test', undefined, 'some_branch')),
    ).toBe(false);
  });

  it('test_is_event_in_branch_same_branch', () => {
    expect(
      isEventInBranch('root.child', event('test', undefined, 'root.child')),
    ).toBe(true);
  });

  it('test_is_event_in_branch_different_branch', () => {
    expect(
      isEventInBranch('root.child', event('test', undefined, 'root.other')),
    ).toBe(false);
  });

  it('test_is_event_in_branch_root_events_included', () => {
    expect(isEventInBranch('root.child', event('test'))).toBe(true);
  });

  it('test_find_previous_interaction_id_returns_latest_for_agent', () => {
    const state = findPreviousInteractionState(
      [
        event('my_agent', 'int_1'),
        event('user'),
        event('my_agent', 'int_2'),
        event('other_agent', 'int_3'),
      ],
      'my_agent',
    );

    expect(state.interactionId).toBe('int_2');
  });

  it('test_find_previous_interaction_id_respects_branch', () => {
    const state = findPreviousInteractionState(
      [
        event('my_agent', 'int_main'),
        event('my_agent', 'int_other_branch', 'branch_b'),
      ],
      'my_agent',
      'branch_a',
    );

    expect(state.interactionId).toBe('int_main');
  });

  it('test_find_previous_interaction_id_none_when_absent', () => {
    const state = findPreviousInteractionState([event('user')], 'my_agent');

    expect(state.interactionId).toBeUndefined();
  });

  it('test_find_previous_interaction_state_returns_both_ids', () => {
    const state = findPreviousInteractionState(
      [
        event('my_agent', 'int_1', undefined, 'env_1'),
        event('user'),
        event('my_agent', 'int_2', undefined, 'env_2'),
      ],
      'my_agent',
    );

    expect(state).toEqual({interactionId: 'int_2', environmentId: 'env_2'});
  });

  /**
   * Substitutes the reference's
   * `test_single_flow_extracts_interaction_state_before_contents`. adk-js has
   * no `SingleFlow`, and it runs the interactions processor *after* the content
   * processor on purpose: adk-python trims chained history in `contents.py`,
   * while adk-js trims it one layer down in `generateContentViaInteractions`.
   * Only the membership is a contract here, so only membership is asserted.
   */
  it('registers the interactions processor in the default LlmAgent pipeline', () => {
    const agent = new LlmAgent({
      name: AGENT_NAME,
      model: new Gemini({model: 'gemini-2.5-flash', apiKey: 'dummy'}),
    });

    expect(agent.requestProcessors).toContain(INTERACTIONS_REQUEST_PROCESSOR);
  });

  it('returns no ids for an empty event list', () => {
    expect(findPreviousInteractionState([], AGENT_NAME)).toEqual({});
  });

  it('chains runAsync on a branch-less event while a branch is set', async () => {
    const llmRequest = await runProcessor(
      interactionsContext([event(AGENT_NAME, 'int-root')], 'root.child'),
    );

    expect(llmRequest.previousInteractionId).toBe('int-root');
  });

  it('prefers a branch-less event over a later event from another branch', async () => {
    const llmRequest = await runProcessor(
      interactionsContext(
        [
          event(AGENT_NAME, 'int-root'),
          event(AGENT_NAME, 'int-other', 'root.other'),
        ],
        'root.child',
      ),
    );

    expect(llmRequest.previousInteractionId).toBe('int-root');
  });

  it('logs the skipped event and the interaction id it found', async () => {
    const debugSpy = vi.spyOn(getLogger(), 'debug');

    await runProcessor(
      interactionsContext(
        [
          event(AGENT_NAME, 'int-root'),
          event(AGENT_NAME, 'int-other', 'root.other'),
        ],
        'root.child',
      ),
    );

    const lines = debugSpy.mock.calls.map((call) => call.join(' '));
    expect(lines).toContainEqual(
      expect.stringContaining(
        `Skipping event not in branch: author=${AGENT_NAME}, ` +
          'branch=root.other, current=root.child',
      ),
    );
    expect(lines).toContainEqual(
      expect.stringContaining(
        `Found interaction_id from agent ${AGENT_NAME}: int-root`,
      ),
    );
  });
});
