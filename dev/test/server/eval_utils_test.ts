/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createSession} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {convertSessionToEvalInvocations} from '../../src/server/eval_utils.js';

describe('eval_utils', () => {
  describe('convertSessionToEvalInvocations', () => {
    it('should return empty list if session has no events', () => {
      const session = createSession({id: 's1', appName: 'app'});
      const invocations = convertSessionToEvalInvocations(session);
      expect(invocations).toEqual([]);
    });

    it('should convert simple user-model turn', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        events: [
          createEvent({
            invocationId: 'inv1',
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello'}]},
            timestamp: 1000,
          }),
          createEvent({
            invocationId: 'inv1',
            author: 'agent',
            content: {role: 'model', parts: [{text: 'hi'}]},
            timestamp: 2000,
          }),
        ],
      });

      const invocations = convertSessionToEvalInvocations(session);
      expect(invocations.length).toBe(1);

      const inv = invocations[0];
      expect(inv.invocationId).toBe('inv1');
      expect(inv.userContent).toEqual({role: 'user', parts: [{text: 'hello'}]});
      expect(inv.finalResponse).toEqual({role: 'model', parts: [{text: 'hi'}]});
      expect(inv.creationTimestamp).toBe(1.0);
      expect(inv.intermediateData.invocation_events).toEqual([]);
    });

    it('should include intermediate tool calls', () => {
      const session = createSession({
        id: 's1',
        appName: 'app',
        events: [
          createEvent({
            invocationId: 'inv1',
            author: 'user',
            content: {role: 'user', parts: [{text: 'use tool'}]},
            timestamp: 1000,
          }),
          createEvent({
            invocationId: 'inv1',
            author: 'agent',
            content: {
              role: 'model',
              parts: [{functionCall: {name: 'tool1', args: {x: 1}}}],
            },
            timestamp: 2000,
          }),
          createEvent({
            invocationId: 'inv1',
            author: 'agent',
            content: {
              role: 'tool',
              parts: [
                {functionResponse: {name: 'tool1', response: {result: 'ok'}}},
              ],
            },
            timestamp: 3000,
          }),
          createEvent({
            invocationId: 'inv1',
            author: 'agent',
            content: {role: 'model', parts: [{text: 'done'}]},
            timestamp: 4000,
          }),
        ],
      });

      const invocations = convertSessionToEvalInvocations(session);
      expect(invocations.length).toBe(1);

      const inv = invocations[0];
      expect(inv.intermediateData.invocation_events.length).toBe(2);
      expect(
        inv.intermediateData.invocation_events[0].content.parts[0].functionCall,
      ).toEqual({
        name: 'tool1',
        args: {x: 1},
      });
      expect(
        inv.intermediateData.invocation_events[1].content.parts[0]
          .functionResponse,
      ).toEqual({
        name: 'tool1',
        response: {result: 'ok'},
      });
      expect(inv.finalResponse).toEqual({
        role: 'model',
        parts: [{text: 'done'}],
      });
    });
  });
});
