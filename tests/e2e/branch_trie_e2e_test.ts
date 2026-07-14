/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CONTENT_REQUEST_PROCESSOR,
  createEvent,
  EventBranchTrie,
  filterEventsByBranch,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  type LlmRequest,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('E2E Trie Branch Event Filtering', () => {
  it('should verify end-to-end multi-agent branch segregation using EventBranchTrie and CONTENT_REQUEST_PROCESSOR', async () => {
    // 1. Create a simulated session history representing a multi-agent workflow
    // with root instructions and parallel sub-agent branches.
    const rootUserEvent = createEvent({
      author: 'user',
      content: {role: 'user', parts: [{text: 'Start multi-agent research'}]},
    });

    const coordinatorEvent = createEvent({
      author: 'parallel_coord',
      branch: 'root.parallel',
      content: {role: 'model', parts: [{text: 'Spawning sub-agents'}]},
    });

    const researcherEvent = createEvent({
      author: 'researcher',
      branch: 'root.parallel.researcher',
      content: {
        role: 'model',
        parts: [{text: 'Research findings: Trie is O(K+M)'}],
      },
    });

    const writerEvent = createEvent({
      author: 'writer',
      branch: 'root.parallel.writer',
      content: {
        role: 'model',
        parts: [{text: 'Drafting document on Trie optimization'}],
      },
    });

    const sessionEvents = [
      rootUserEvent,
      coordinatorEvent,
      researcherEvent,
      writerEvent,
    ];

    // 2. Verify EventBranchTrie directly segregates branches end-to-end via public API
    const trie = EventBranchTrie.fromEvents(sessionEvents);
    const researcherBranchEvents = trie.getMatchingEvents(
      'root.parallel.researcher',
    );

    expect(researcherBranchEvents).toEqual([
      rootUserEvent,
      coordinatorEvent,
      researcherEvent,
    ]);
    expect(researcherBranchEvents).not.toContain(writerEvent);

    const writerBranchEvents = trie.getMatchingEvents('root.parallel.writer');
    expect(writerBranchEvents).toEqual([
      rootUserEvent,
      coordinatorEvent,
      writerEvent,
    ]);
    expect(writerBranchEvents).not.toContain(researcherEvent);

    // 3. Verify filterEventsByBranch public utility function
    const filteredResearcherEvents = filterEventsByBranch(
      sessionEvents,
      'root.parallel.researcher',
    );
    expect(filteredResearcherEvents).toEqual(researcherBranchEvents);

    // 4. Verify CONTENT_REQUEST_PROCESSOR (which uses getContents + EventBranchTrie internally)
    // prepares LLM prompt contents strictly isolated to the executing agent's branch hierarchy.
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'e2e_trie_test',
      userId: 'test_user',
    });
    for (const ev of sessionEvents) {
      await sessionService.appendEvent({session, event: ev});
    }

    const researcherAgent = new LlmAgent({
      name: 'researcher',
      model: 'dummy-model',
    });
    const researcherInvocationContext = new InvocationContext({
      sessionService,
      session,
      agent: researcherAgent,
      branch: 'root.parallel.researcher',
    });

    const researcherLlmRequest: LlmRequest = {};
    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      researcherInvocationContext,
      researcherLlmRequest,
    )) {
      // Consume async generator
    }

    expect(researcherLlmRequest.contents).toBeDefined();
    expect(researcherLlmRequest.contents).toHaveLength(3);
    expect(researcherLlmRequest.contents?.[0].role).toBe('user');
    expect(researcherLlmRequest.contents?.[0].parts?.[0].text).toBe(
      'Start multi-agent research',
    );
    expect(researcherLlmRequest.contents?.[2].parts?.[0].text).toBe(
      'Research findings: Trie is O(K+M)',
    );

    // Verify writer agent receives only writer branch context when prepared by CONTENT_REQUEST_PROCESSOR
    const writerAgent = new LlmAgent({
      name: 'writer',
      model: 'dummy-model',
    });
    const writerInvocationContext = new InvocationContext({
      sessionService,
      session,
      agent: writerAgent,
      branch: 'root.parallel.writer',
    });

    const writerLlmRequest: LlmRequest = {};
    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      writerInvocationContext,
      writerLlmRequest,
    )) {
      // Consume async generator
    }

    expect(writerLlmRequest.contents).toHaveLength(3);
    expect(writerLlmRequest.contents?.[2].parts?.[0].text).toBe(
      'Drafting document on Trie optimization',
    );
  });
});
