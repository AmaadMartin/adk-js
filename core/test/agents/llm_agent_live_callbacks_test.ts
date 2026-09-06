/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

import {ScriptedLiveLlm} from './live_test_helpers.js';

const APP_NAME = 'app';
const USER_ID = 'user';
const SESSION_ID = 'session-id';

const BLOCKED_RESPONSE: LlmResponse = {
  content: {role: 'model', parts: [{text: 'blocked by policy'}]},
};

function textOf(event: Event): string | undefined {
  return event.content?.parts?.[0].text;
}

describe('LlmAgent live model callbacks', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  async function runLive(
    agent: LlmAgent,
    seedRequests: (queue: LiveRequestQueue) => void,
  ): Promise<Event[]> {
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
      artifactService: new InMemoryArtifactService(),
    });
    const queue = new LiveRequestQueue();
    seedRequests(queue);
    queue.close();

    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: USER_ID,
      sessionId: SESSION_ID,
      liveRequestQueue: queue,
    })) {
      events.push(event);
    }
    return events;
  }

  describe('before-model callback', () => {
    it('screens the user typed text once', async () => {
      const llm = new ScriptedLiveLlm([[{turnComplete: true}]]);
      const screened: LlmRequest[] = [];
      const agent = new LlmAgent({
        name: 'agent',
        model: llm,
        beforeModelCallback: ({request}) => {
          screened.push(request);
          return undefined;
        },
      });

      await runLive(agent, (queue) => {
        queue.send({content: {role: 'user', parts: [{text: 'hello'}]}});
      });

      expect(screened).toHaveLength(1);
      expect(screened[0].contents).toEqual([
        {role: 'user', parts: [{text: 'hello'}]},
      ]);
      expect(llm.connections[0].contentCalls).toEqual([
        {role: 'user', parts: [{text: 'hello'}]},
      ]);
    });

    it('does not screen a function response the client sends back', async () => {
      const llm = new ScriptedLiveLlm([[{turnComplete: true}]]);
      const screened: LlmRequest[] = [];
      const agent = new LlmAgent({
        name: 'agent',
        model: llm,
        beforeModelCallback: ({request}) => {
          screened.push(request);
          return undefined;
        },
      });

      await runLive(agent, (queue) => {
        queue.send({
          content: {
            role: 'user',
            parts: [{functionResponse: {name: 'echo', response: {ok: true}}}],
          },
        });
      });

      expect(screened).toEqual([]);
    });

    it('keeps a blocked message out of the model and does not restart', async () => {
      const llm = new ScriptedLiveLlm([[{turnComplete: true}]]);
      const agent = new LlmAgent({
        name: 'agent',
        model: llm,
        beforeModelCallback: () => BLOCKED_RESPONSE,
      });

      const events = await runLive(agent, (queue) => {
        queue.send({content: {role: 'user', parts: [{text: 'forbidden'}]}});
      });

      const blocked = events.find(
        (event) => textOf(event) === 'blocked by policy',
      );
      expect(blocked?.turnComplete).toBe(true);
      expect(llm.connections[0].contentCalls).toEqual([]);
      // A block before the model saw anything needs no new session.
      expect(llm.connections).toHaveLength(1);

      const session = await sessionService.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      });
      const userTexts = session!.events
        .filter((event) => event.author === 'user')
        .map(textOf);
      expect(userTexts).toContain('forbidden');
    });

    it('screens a finished input transcription but not a partial one', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {inputTranscription: {text: 'partial ', finished: false}},
          {inputTranscription: {text: 'partial words', finished: true}},
          {turnComplete: true},
        ],
      ]);
      const screened: LlmRequest[] = [];
      const agent = new LlmAgent({
        name: 'agent',
        model: llm,
        beforeModelCallback: ({request}) => {
          screened.push(request);
          return undefined;
        },
      });

      await runLive(agent, () => {});

      expect(screened).toHaveLength(1);
      expect(screened[0].contents).toEqual([
        {role: 'user', parts: [{text: 'partial words'}]},
      ]);
    });

    it('yields the spoken input before the block, then restarts', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {inputTranscription: {text: 'forbidden words', finished: true}},
          {turnComplete: true},
        ],
        [{turnComplete: true}],
      ]);
      let blocks = 0;
      const agent = new LlmAgent({
        name: 'agent',
        model: llm,
        beforeModelCallback: () =>
          blocks++ === 0 ? BLOCKED_RESPONSE : undefined,
      });

      const events = await runLive(agent, () => {});

      const transcriptionIndex = events.findIndex(
        (event) => event.inputTranscription?.text === 'forbidden words',
      );
      const blockedIndex = events.findIndex(
        (event) => textOf(event) === 'blocked by policy',
      );
      expect(transcriptionIndex).toBeGreaterThanOrEqual(0);
      expect(blockedIndex).toBeGreaterThan(transcriptionIndex);
      expect(events[blockedIndex].turnComplete).toBe(true);
      expect(llm.connections).toHaveLength(2);
    });
  });

  describe('after-model callback', () => {
    it('screens the output transcription the model has spoken so far', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {outputTranscription: {text: 'one ', finished: false}},
          {outputTranscription: {text: 'two', finished: false}},
          {turnComplete: true},
        ],
      ]);
      const screened: string[] = [];
      const agent = new LlmAgent({
        name: 'agent',
        model: llm,
        afterModelCallback: ({response}) => {
          screened.push(response.outputTranscription?.text ?? '');
          return undefined;
        },
      });

      await runLive(agent, () => {});

      expect(screened).toEqual(['one ', 'one two']);
    });

    it('does not screen a finished transcription, which carries no new text', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {outputTranscription: {text: 'spoken', finished: true}},
          {turnComplete: true},
        ],
      ]);
      const screened: string[] = [];
      const agent = new LlmAgent({
        name: 'agent',
        model: llm,
        afterModelCallback: ({response}) => {
          screened.push(response.outputTranscription?.text ?? '');
          return undefined;
        },
      });

      await runLive(agent, () => {});

      expect(screened).toEqual([]);
    });

    it('restarts and drops the rest of the turn when the output is blocked', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {outputTranscription: {text: 'forbidden', finished: false}},
          {content: {role: 'model', parts: [{text: 'rest of the turn'}]}},
          {turnComplete: true},
        ],
        [{turnComplete: true}],
      ]);
      let blocks = 0;
      const agent = new LlmAgent({
        name: 'agent',
        model: llm,
        afterModelCallback: () =>
          blocks++ === 0 ? BLOCKED_RESPONSE : undefined,
      });

      const events = await runLive(agent, () => {});

      const blocked = events.find(
        (event) => textOf(event) === 'blocked by policy',
      );
      expect(blocked?.turnComplete).toBe(true);
      expect(events.some((event) => textOf(event) === 'rest of the turn')).toBe(
        false,
      );
      expect(llm.connections).toHaveLength(2);
    });
  });

  describe('turns that nothing blocks', () => {
    it('passes a turn through unchanged when the callbacks return nothing', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {content: {role: 'model', parts: [{text: 'hello back'}]}},
          {outputTranscription: {text: 'hello back', finished: false}},
          {turnComplete: true},
        ],
      ]);
      const agent = new LlmAgent({
        name: 'agent',
        model: llm,
        beforeModelCallback: () => undefined,
        afterModelCallback: () => undefined,
      });

      const events = await runLive(agent, (queue) => {
        queue.send({content: {role: 'user', parts: [{text: 'hello'}]}});
      });

      expect(events.map(textOf)).toContain('hello back');
      expect(events.some((event) => event.turnComplete)).toBe(true);
      expect(llm.connections).toHaveLength(1);
    });

    it('passes a turn through unchanged when no callback is registered', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {content: {role: 'model', parts: [{text: 'hello back'}]}},
          {turnComplete: true},
        ],
      ]);
      const agent = new LlmAgent({name: 'agent', model: llm});

      const events = await runLive(agent, (queue) => {
        queue.send({content: {role: 'user', parts: [{text: 'hello'}]}});
      });

      expect(events.map(textOf)).toContain('hello back');
      expect(llm.connections).toHaveLength(1);
    });
  });
});
