/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TextPart} from '@a2a-js/sdk';
import {describe, expect, it} from 'vitest';
import {
  getFunctionResponseCallId,
  getUserFunctionCallAt,
  isFunctionCallEvent,
  presentAsUserMessage,
  toMissingRemoteSessionParts,
  unwrapPauseAnswers,
} from '../../src/a2a/a2a_remote_agent_utils.js';
import {
  MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_AUTH,
  MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_INPUT,
} from '../../src/a2a/event_converter_utils.js';
import {AdkMetadataKeys} from '../../src/a2a/metadata_converter_utils.js';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent} from '../../src/events/event.js';
import {Session} from '../../src/sessions/session.js';

describe('remote_agent_utils', () => {
  const mockAgent = {
    name: 'test-agent',
  } as unknown as BaseAgent;

  const mockCtx = {
    agent: mockAgent,
    invocationId: 'test-invocation-id',
  } as unknown as InvocationContext;

  describe('getFunctionResponseCallId', () => {
    it('should return undefined if no content', () => {
      const event = createEvent({author: 'user'});
      expect(getFunctionResponseCallId(event)).toBeUndefined();
    });

    it('should return call ID if functionResponse present', () => {
      const event = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-123',
                name: 'test_tool',
                response: {result: 'ok'},
              },
            },
          ],
        },
      });
      expect(getFunctionResponseCallId(event)).toBe('call-123');
    });
  });

  describe('isFunctionCallEvent', () => {
    it('should return false if no content', () => {
      const event = createEvent({author: 'user'});
      expect(isFunctionCallEvent(event, 'call-123')).toBe(false);
    });

    it('should return true if functionCall ID matches', () => {
      const event = createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-123',
                name: 'test_tool',
                args: {},
              },
            },
          ],
        },
      });
      expect(isFunctionCallEvent(event, 'call-123')).toBe(true);
    });

    it('should return false if functionCall ID does not match', () => {
      const event = createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-456',
                name: 'test_tool',
                args: {},
              },
            },
          ],
        },
      });
      expect(isFunctionCallEvent(event, 'call-123')).toBe(false);
    });
  });

  describe('getUserFunctionCallAt', () => {
    it('should return undefined for invalid index', () => {
      const session = {events: []} as unknown as Session;
      expect(getUserFunctionCallAt(session, 0)).toBeUndefined();
    });

    it('should return undefined if event author is not user', () => {
      const event = createEvent({author: 'agent'});
      const session = {events: [event]} as unknown as Session;
      expect(getUserFunctionCallAt(session, 0)).toBeUndefined();
    });

    it('should return undefined if no functionResponse', () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      });
      const session = {events: [event]} as unknown as Session;
      expect(getUserFunctionCallAt(session, 0)).toBeUndefined();
    });

    it('should return UserFunctionCall if request event found', () => {
      const requestEvent = createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call-123', name: 'tool'}}],
        },
        customMetadata: {
          [AdkMetadataKeys.TASK_ID]: 'task-123',
          [AdkMetadataKeys.CONTEXT_ID]: 'ctx-123',
        },
      });

      const responseEvent = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [{functionResponse: {id: 'call-123', name: 'tool'}}],
        },
      });

      const session = {
        events: [requestEvent, responseEvent],
      } as unknown as Session;

      const result = getUserFunctionCallAt(session, 1);
      expect(result).toBeDefined();
      expect(result?.taskId).toBe('task-123');
      expect(result?.contextId).toBe('ctx-123');
      expect(result?.response).toBe(responseEvent);
    });
  });

  describe('presentAsUserMessage', () => {
    it('should handle text parts', () => {
      const agentEvent = createEvent({
        author: 'other-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });

      const result = presentAsUserMessage(mockCtx, agentEvent);
      expect(result.author).toBe('user');
      expect(result.content?.parts![0].text).toBe('For context:');
      expect(result.content?.parts![1].text).toBe('[other-agent] said: hello');
    });

    it('should handle functionCall parts', () => {
      const agentEvent = createEvent({
        author: 'other-agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool', args: {x: 1}}}],
        },
      });

      const result = presentAsUserMessage(mockCtx, agentEvent);
      expect(result.content?.parts![1].text).toContain('called tool tool');
      expect(result.content?.parts![1].text).toContain('{"x":1}');
    });

    it('should handle functionResponse parts', () => {
      const agentEvent = createEvent({
        author: 'other-agent',
        content: {
          role: 'model',
          parts: [{functionResponse: {name: 'tool', response: {y: 2}}}],
        },
      });

      const result = presentAsUserMessage(mockCtx, agentEvent);
      expect(result.content?.parts![1].text).toContain('tool returned result');
      expect(result.content?.parts![1].text).toContain('{"y":2}');
    });
  });

  describe('unwrapPauseAnswers', () => {
    it('rewrites an input pause answer as text', () => {
      const parts = unwrapPauseAnswers([
        {
          functionResponse: {
            id: 'fc-1',
            name: MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_INPUT,
            response: {'result': 'us-central1'},
          },
        },
      ]);

      expect(parts).toEqual([{text: 'us-central1'}]);
    });

    it('rewrites an auth pause answer as text', () => {
      const parts = unwrapPauseAnswers([
        {
          functionResponse: {
            id: 'fc-1',
            name: MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_AUTH,
            response: {'result': 'token-abc'},
          },
        },
      ]);

      expect(parts).toEqual([{text: 'token-abc'}]);
    });

    it('stringifies a non-string result', () => {
      const parts = unwrapPauseAnswers([
        {
          functionResponse: {
            id: 'fc-1',
            name: MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_INPUT,
            response: {'result': 42},
          },
        },
      ]);

      expect(parts).toEqual([{text: '42'}]);
    });

    it('keeps every other part untouched', () => {
      const original = [
        {text: 'Approved'},
        {
          functionResponse: {
            id: 'fc-2',
            name: 'request_approval',
            response: {'result': 'yes'},
          },
        },
        {
          functionResponse: {
            id: 'fc-1',
            name: MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_INPUT,
            response: {'result': 'us-central1'},
          },
        },
      ];

      const parts = unwrapPauseAnswers(original);

      expect(parts).toEqual([original[0], original[1], {text: 'us-central1'}]);
    });

    it('keeps a pause answer that carries no result', () => {
      const original = [
        {
          functionResponse: {
            id: 'fc-1',
            name: MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_INPUT,
            response: {'status': 'approved'},
          },
        },
      ];

      expect(unwrapPauseAnswers(original)).toEqual(original);
    });

    it('keeps a pause answer with no response at all', () => {
      const original = [
        {
          functionResponse: {
            id: 'fc-1',
            name: MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_INPUT,
          },
        },
      ];

      expect(unwrapPauseAnswers(original)).toEqual(original);
    });

    it('keeps a part that is not a function response', () => {
      const original = [{text: 'plain'}, {functionCall: {id: 'c', name: 'n'}}];

      expect(unwrapPauseAnswers(original)).toEqual(original);
    });
  });

  describe('toMissingRemoteSessionParts', () => {
    it('should return all parts if no previous remote response', () => {
      const event1 = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      });
      const session = {events: [event1]} as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      expect(result.parts.length).toBe(1);
      expect((result.parts[0] as TextPart).text).toBe('hello');
      expect(result.contextId).toBeUndefined();
    });

    it('should only return parts after last remote response', () => {
      const remoteResponse = createEvent({
        author: 'test-agent',
        content: {role: 'model', parts: [{text: 'response'}]},
        customMetadata: {
          [AdkMetadataKeys.CONTEXT_ID]: 'ctx-remote',
        },
      });
      const newUserMessage = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'new message'}]},
      });

      const session = {
        events: [remoteResponse, newUserMessage],
      } as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      expect(result.parts.length).toBe(1);
      expect((result.parts[0] as TextPart).text).toBe('new message');
      expect(result.contextId).toBe('ctx-remote');
    });

    it('should wrap other agent messages as user message', () => {
      const otherAgent = createEvent({
        author: 'other-agent',
        content: {role: 'model', parts: [{text: 'other response'}]},
      });

      const session = {events: [otherAgent]} as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      expect(result.parts.length).toBe(2); // "For context:" and "[other-agent] said: ..."
      expect((result.parts[0] as TextPart).text).toBe('For context:');
      expect((result.parts[1] as TextPart).text).toBe(
        '[other-agent] said: other response',
      );
    });
  });
});
