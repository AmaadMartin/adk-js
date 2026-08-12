/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {createEvent, createEventActions} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {A2AEvent} from '../../src/a2a/a2a_event.js';
import {
  MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_AUTH,
  MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_INPUT,
  toA2AMessage,
  toAdkEvent,
} from '../../src/a2a/event_converter_utils.js';
import * as envAwareUtils from '../../src/utils/env_aware_utils.js';

vi.mock('../../src/utils/env_aware_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/env_aware_utils.js')>();
  return {
    ...actual,
    randomUUID: vi.fn(),
  };
});

describe('event_converter_utils', () => {
  describe('toA2AMessage', () => {
    it('converts a simple user event to an A2A message', () => {
      vi.mocked(envAwareUtils.randomUUID).mockReturnValue('test-uuid-1');
      const event = createEvent({
        invocationId: 'inv1',
        author: 'user',
        content: {
          role: 'user',
          parts: [{text: 'hello'}],
        },
      });

      const message = toA2AMessage(event, {
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
      });
      expect(message).toBeDefined();
      expect(message).toMatchObject({
        kind: 'message',
        messageId: 'test-uuid-1',
        role: 'user',
        parts: [{kind: 'text', text: 'hello'}],
        metadata: {
          'adk_app_name': 'test-app',
          'adk_user_id': 'test-user',
          'adk_session_id': 'test-session',
        },
      });
    });

    it('converts agent event with actions and custom metadata', () => {
      vi.mocked(envAwareUtils.randomUUID).mockReturnValue('test-uuid-2');
      const actions = createEventActions();
      actions.escalate = true;
      actions.transferToAgent = 'human';

      const event = createEvent({
        invocationId: 'inv2',
        author: 'agent_1',
        content: {
          role: 'model',
          parts: [{text: 'response'}],
        },
        actions,
        customMetadata: {
          'custom_key': 'custom_value',
        },
      });

      const message = toA2AMessage(event, {
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
      });
      expect(message).toBeDefined();
      expect(message).toMatchObject({
        kind: 'message',
        messageId: 'test-uuid-2',
        role: 'agent',
        parts: [{kind: 'text', text: 'response'}],
        metadata: {
          'adk_escalate': true,
          'adk_transfer_to_agent': 'human',
          'adk_custom_metadata': {
            'custom_key': 'custom_value',
          },
        },
      });
    });
  });

  describe('toAdkEvent', () => {
    it('returns undefined for unknown event type', () => {
      expect(
        toAdkEvent({kind: 'unknown'} as unknown as A2AEvent, 'inv', 'agent'),
      ).toBe(undefined);
    });

    it('populates AdkEvent fields from metadata', () => {
      const message: Message = {
        kind: 'message',
        messageId: 'msg1',
        role: 'agent',
        parts: [{kind: 'text', text: 'hello'}],
        metadata: {
          'adk_branch': 'test-branch',
          'adk_error_code': '404',
          'adk_error_message': 'not found',
        },
      };

      const event = toAdkEvent(message, 'inv1', 'agent1');
      expect(event).toBeDefined();
      expect(event!.errorCode).toBe('404');
      expect(event!.errorMessage).toBe('not found');
    });

    it('never restores branch from peer-supplied metadata, even without a caller-supplied branch', () => {
      // A remote A2A peer fully controls its own outgoing `adk_branch`
      // metadata. getContents() (content_processor_utils.ts) uses an
      // event's `branch` to keep sibling sub-agent conversation contexts
      // isolated, so restoring it from peer metadata would let a malicious
      // peer forge a shared-ancestor (or absent) branch to leak its content
      // into an unrelated sibling agent's LLM context.
      const message: Message = {
        kind: 'message',
        messageId: 'msg-forged-branch',
        role: 'agent',
        parts: [{kind: 'text', text: 'hello'}],
        metadata: {'adk_branch': 'forged-parent-branch'},
      };

      const event = toAdkEvent(message, 'inv1', 'agent1');
      expect(event!.branch).toBeUndefined();
    });

    it('sets branch from the caller-supplied local invocation branch, not from peer metadata', () => {
      const message: Message = {
        kind: 'message',
        messageId: 'msg-branch-override',
        role: 'agent',
        parts: [{kind: 'text', text: 'hello'}],
        metadata: {'adk_branch': 'forged-parent-branch'},
      };

      const event = toAdkEvent(
        message,
        'inv1',
        'agent1',
        'coordinator.sub_agent_a',
      );
      expect(event!.branch).toBe('coordinator.sub_agent_a');
    });

    describe('Message', () => {
      it('preserves messages without parts as contentless events', () => {
        const userMessage: Message = {
          kind: 'message',
          messageId: 'msg-empty-user',
          role: 'user',
          parts: [],
        };
        const agentMessage: Message = {
          kind: 'message',
          messageId: 'msg-empty-agent',
          role: 'agent',
          parts: [],
          metadata: {'adk_error_code': 'EMPTY_RESPONSE'},
        };

        const userEvent = toAdkEvent(userMessage, 'inv1', 'agent1');
        const agentEvent = toAdkEvent(agentMessage, 'inv1', 'agent1');

        expect(userEvent).toMatchObject({
          author: 'user',
          content: undefined,
          turnComplete: true,
        });
        expect(agentEvent).toMatchObject({
          author: 'agent1',
          content: undefined,
          errorCode: 'EMPTY_RESPONSE',
          turnComplete: true,
        });
      });

      it('converts user message to AdkEvent', () => {
        const message: Message = {
          kind: 'message',
          messageId: 'msg1',
          role: 'user',
          parts: [{kind: 'text', text: 'hello from user'}],
        };

        const event = toAdkEvent(message, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.author).toBe('user');
        expect(event!.content?.role).toBe('user');
        expect(event!.content?.parts).toEqual([
          {text: 'hello from user', thought: false},
        ]);
        expect(event!.turnComplete).toBe(true);
      });

      it('converts agent message to AdkEvent', () => {
        const message: Message = {
          kind: 'message',
          messageId: 'msg2',
          role: 'agent',
          parts: [{kind: 'text', text: 'hello from agent'}],
          metadata: {
            'adk_escalate': true,
            'adk_transfer_to_agent': 'agent2',
            'adk_custom_metadata': {
              'a2a:task_id': 'task1',
              'a2a:context_id': 'context1',
            },
          },
        };

        const event = toAdkEvent(message, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.author).toBe('agent1');
        expect(event!.content?.role).toBe('model');
        expect(event!.content?.parts).toEqual([
          {text: 'hello from agent', thought: false},
        ]);
        expect(event!.turnComplete).toBe(true);
        expect(event!.actions?.escalate).toBe(true);
        // Peer-supplied `adk_transfer_to_agent` in the fixture below must be
        // dropped, not restored -- it drives the local orchestrator's own
        // control flow and must never come from a remote peer. Asserting
        // `toBeUndefined()` here (rather than removing the assertion) means
        // a future regression that re-restores it fails loudly instead of
        // passing silently.
        expect(event!.actions?.transferToAgent).toBeUndefined();
        expect(event!.customMetadata).toEqual({
          'a2a:task_id': 'task1',
          'a2a:context_id': 'context1',
        });
      });
    });

    describe('TaskStatusUpdateEvent', () => {
      it('converts final status update', () => {
        const finalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'completed',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'done'}],
            },
          },
          final: true,
        };

        const event = toAdkEvent(finalUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.author).toBe('agent1');
        expect(event!.content?.role).toBe('model');
        expect(event!.content?.parts).toEqual([{text: 'done', thought: false}]);
        expect(event!.turnComplete).toBe(true);
      });

      it('converts final status update (failed without message parts)', () => {
        const finalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'failed',
          },
          final: true,
        };

        const event = toAdkEvent(finalUpdate, 'inv1', 'agent1');
        expect(event).toBeUndefined();
      });

      it('converts final status update (failed with text part)', () => {
        const finalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'failed',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'error occurred'}],
            },
          },
          final: true,
        };

        const event = toAdkEvent(finalUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.errorMessage).toBe('error occurred');
        expect(event!.content).toBeUndefined();
        expect(event!.turnComplete).toBe(true);
      });

      it('converts non-final status update with partial message', () => {
        const nonFinalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'working',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'thinking loudly...'}],
            },
          },
          final: false,
        };

        const event = toAdkEvent(nonFinalUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.partial).toBe(true);
        expect(event!.turnComplete).toBe(false);
        expect(event!.content?.parts).toEqual([
          {text: 'thinking loudly...', thought: false},
        ]);
      });

      it('returns undefined for non-final status update with no parts', () => {
        const nonFinalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'working',
            message: {
              kind: 'message',
              messageId: 'msg-empty',
              role: 'agent',
              parts: [],
            },
          },
          final: false,
        };

        expect(toAdkEvent(nonFinalUpdate, 'inv1', 'agent1')).toBeUndefined();
      });

      it('returns undefined if non-final status update has no message', () => {
        const nonFinalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'working',
          },
          final: false,
        };

        expect(toAdkEvent(nonFinalUpdate, 'inv1', 'agent1')).toBeUndefined();
      });

      it('synthesizes an input-required function call on a final status update', () => {
        vi.mocked(envAwareUtils.randomUUID).mockReturnValue('mock-fc-id');
        const finalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'need input'}],
            },
          },
          final: true,
        };

        const event = toAdkEvent(finalUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.content?.parts).toEqual([
          {
            functionCall: {
              id: 'mock-fc-id',
              name: MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_INPUT,
              args: {'input_required': 'need input'},
            },
          },
        ]);
        expect(event!.longRunningToolIds).toEqual(['mock-fc-id']);
        expect(event!.turnComplete).toBe(true);
      });

      it('synthesizes an auth-required function call on a final status update', () => {
        vi.mocked(envAwareUtils.randomUUID).mockReturnValue('mock-fc-id');
        const finalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'auth-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'need auth'}],
            },
          },
          final: true,
        };

        const event = toAdkEvent(finalUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.content?.parts).toEqual([
          {
            functionCall: {
              id: 'mock-fc-id',
              name: MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_AUTH,
              args: {'auth_required': 'need auth'},
            },
          },
        ]);
        expect(event!.longRunningToolIds).toEqual(['mock-fc-id']);
        expect(event!.turnComplete).toBe(true);
      });

      it('does not synthesize on a non-final status update', () => {
        vi.mocked(envAwareUtils.randomUUID).mockReturnValue('mock-fc-id');
        const nonFinalUpdate: TaskStatusUpdateEvent = {
          kind: 'status-update',
          taskId: 'task1',
          contextId: 'context1',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'need input'}],
            },
          },
          final: false,
        };

        const event = toAdkEvent(nonFinalUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.content?.parts).toEqual([
          {text: 'need input', thought: false},
        ]);
        expect(event!.partial).toBe(true);
        expect(event!.turnComplete).toBe(false);
      });
    });

    describe('TaskArtifactUpdateEvent', () => {
      it('converts artifact update with no parts to undefined', () => {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: 'task1',
          contextId: 'context1',
          artifact: {
            artifactId: 'art1',
            parts: [],
          },
        };

        expect(toAdkEvent(artifactUpdate, 'inv1', 'agent1')).toBeUndefined();
      });

      it('sets partial to true when append is true', () => {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: 'task1',
          contextId: 'context1',
          append: true,
          lastChunk: true,
          artifact: {
            artifactId: 'art1',
            parts: [{kind: 'text', text: 'part'}],
          },
        };

        const event = toAdkEvent(artifactUpdate, 'inv1', 'agent1');
        expect(event?.partial).toBe(true);
      });

      it('sets partial to true when lastChunk is false', () => {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: 'task1',
          contextId: 'context1',
          append: false,
          lastChunk: false,
          artifact: {
            artifactId: 'art1',
            parts: [{kind: 'text', text: 'part'}],
          },
        };

        const event = toAdkEvent(artifactUpdate, 'inv1', 'agent1');
        expect(event?.partial).toBe(true);
      });

      it('sets partial to false when append is false and lastChunk is true', () => {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: 'task1',
          contextId: 'context1',
          append: false,
          lastChunk: true,
          artifact: {
            artifactId: 'art1',
            parts: [{kind: 'text', text: 'part'}],
          },
        };

        const event = toAdkEvent(artifactUpdate, 'inv1', 'agent1');
        expect(event?.partial).toBe(false);
      });

      it('converts artifact update', () => {
        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: 'artifact-update',
          taskId: 'task1',
          contextId: 'context1',
          metadata: {
            'adk_custom_metadata': {
              'a2a:task_id': 'task2',
            },
          },
          artifact: {
            artifactId: 'art1',
            parts: [
              {
                kind: 'data',
                data: {id: 'testTool', name: 'testTool', args: {}},
                metadata: {
                  'adk_is_long_running': true,
                  'adk_type': 'function_call',
                },
              },
            ],
            metadata: {
              'adk_partial': true,
              'adk_custom_metadata': {
                'a2a:task_id': 'task2',
              },
              'adk_type': 'function_call',
            },
          },
        };

        const event = toAdkEvent(artifactUpdate, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.partial).toBe(true);
        expect(event!.longRunningToolIds).toEqual(['testTool']);
        expect(event!.customMetadata).toEqual({'a2a:task_id': 'task2'});
        expect(event!.content?.parts).toEqual([
          {functionCall: {id: 'testTool', name: 'testTool', args: {}}},
        ]);
      });
    });

    describe('Task', () => {
      it('returns undefined for task with no parts and non-terminal state', () => {
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {state: 'working'},
        };
        expect(toAdkEvent(task, 'inv1', 'agent1')).toBeUndefined();
      });

      it('returns undefined for completed task with no parts', () => {
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {state: 'completed'},
        };

        expect(toAdkEvent(task, 'inv1', 'agent1')).toBeUndefined();
      });

      it('returns undefined for input-required task with no parts', () => {
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {state: 'input-required'},
        };

        expect(toAdkEvent(task, 'inv1', 'agent1')).toBeUndefined();
      });

      it('converts completed task with artifacts and status message', () => {
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          artifacts: [
            {
              artifactId: 'art1',
              parts: [
                {
                  kind: 'data',
                  data: {id: 'artTool', name: 'artTool', args: {}},
                  metadata: {
                    'adk_is_long_running': true,
                    'adk_type': 'function_call',
                  },
                },
              ],
            },
          ],
          status: {
            state: 'completed',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'task complete'}],
            },
          },
          metadata: {
            'adk_custom_metadata': {
              'a2a:task_id': 't1',
              'a2a:context_id': 'c1',
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.turnComplete).toBe(true);
        expect(event!.longRunningToolIds).toEqual(['artTool']);
        expect(event!.content?.parts).toEqual([
          {functionCall: {id: 'artTool', name: 'artTool', args: {}}},
          {text: 'task complete', thought: false},
        ]);
        expect(event!.customMetadata).toEqual({
          'a2a:task_id': 't1',
          'a2a:context_id': 'c1',
        });
      });

      it('converts failed task with text error message', () => {
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'failed',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'task failed miserably'}],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.turnComplete).toBe(true);
        expect(event!.errorMessage).toBe('task failed miserably');
        expect(event!.content).toBeUndefined();
      });

      it('converts input-required task and extracts longRunningToolIds', () => {
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [
                {
                  kind: 'data',
                  data: {id: 'inputTool', name: 'inputTool', args: {}},
                  metadata: {
                    'adk_is_long_running': true,
                    'adk_type': 'function_call',
                  },
                },
              ],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.turnComplete).toBe(true);
        expect(event!.longRunningToolIds).toEqual(['inputTool']);
      });

      it('synthesizes an input-required function call from the last text part', () => {
        vi.mocked(envAwareUtils.randomUUID).mockReturnValue('mock-fc-id');
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'need input'}],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.content?.parts).toEqual([
          {
            functionCall: {
              id: 'mock-fc-id',
              name: MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_INPUT,
              args: {'input_required': 'need input'},
            },
          },
        ]);
        expect(event!.longRunningToolIds).toEqual(['mock-fc-id']);
        expect(event!.turnComplete).toBe(true);
      });

      it('synthesizes an auth-required function call with the auth args key', () => {
        vi.mocked(envAwareUtils.randomUUID).mockReturnValue('mock-fc-id');
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'auth-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'need auth'}],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        const functionCall = event!.content?.parts?.[0].functionCall;
        expect(functionCall?.name).toBe(
          MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_AUTH,
        );
        expect(functionCall?.args).toEqual({'auth_required': 'need auth'});
        expect(functionCall?.args).not.toHaveProperty('input_required');
        expect(event!.longRunningToolIds).toEqual(['mock-fc-id']);
        expect(event!.turnComplete).toBe(true);
      });

      it('replaces only the last text part', () => {
        vi.mocked(envAwareUtils.randomUUID).mockReturnValue('mock-fc-id');
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [
                {kind: 'text', text: 'Part 1'},
                {kind: 'text', text: 'Part 2'},
              ],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.content?.parts).toEqual([
          {text: 'Part 1', thought: false},
          {
            functionCall: {
              id: 'mock-fc-id',
              name: MOCK_FUNCTION_CALL_FOR_REQUIRED_USER_INPUT,
              args: {'input_required': 'Part 2'},
            },
          },
        ]);
      });

      it('does not synthesize when the task already has long-running ids', () => {
        vi.mocked(envAwareUtils.randomUUID).mockReturnValue('mock-fc-id');
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [
                {
                  kind: 'data',
                  data: {id: 'inputTool', name: 'inputTool', args: {}},
                  metadata: {
                    'adk_is_long_running': true,
                    'adk_type': 'function_call',
                  },
                },
                {kind: 'text', text: 'confirm?'},
              ],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.longRunningToolIds).toEqual(['inputTool']);
        expect(event!.content?.parts).toEqual([
          {functionCall: {id: 'inputTool', name: 'inputTool', args: {}}},
          {text: 'confirm?', thought: false},
        ]);
      });

      it('does not synthesize when no part carries a prompt', () => {
        vi.mocked(envAwareUtils.randomUUID).mockReturnValue('mock-fc-id');
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [
                {
                  kind: 'file',
                  file: {bytes: 'aGVsbG8=', mimeType: 'image/jpeg'},
                },
              ],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.content?.parts).toEqual([
          {inlineData: {data: 'aGVsbG8=', mimeType: 'image/jpeg'}},
        ]);
        expect(event!.longRunningToolIds).toEqual([]);
      });

      it('does not synthesize for a completed task', () => {
        vi.mocked(envAwareUtils.randomUUID).mockReturnValue('mock-fc-id');
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'completed',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'text', text: 'all done'}],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        expect(event!.content?.parts).toEqual([
          {text: 'all done', thought: false},
        ]);
        expect(event!.longRunningToolIds).toEqual([]);
      });

      it('uses a data part JSON payload as the prompt', () => {
        vi.mocked(envAwareUtils.randomUUID).mockReturnValue('mock-fc-id');
        const data = {id: 'abc123', text: 'Please confirm'};
        const task: Task = {
          kind: 'task',
          id: 'task1',
          contextId: 'context1',
          status: {
            state: 'input-required',
            message: {
              kind: 'message',
              messageId: 'msg1',
              role: 'agent',
              parts: [{kind: 'data', data}],
            },
          },
        };

        const event = toAdkEvent(task, 'inv1', 'agent1');
        expect(event).toBeDefined();
        // toGenAIPartData renders a data part with no `adk_type` as JSON text,
        // so the prompt is the serialized payload rather than the object.
        expect(event!.content?.parts?.[0].functionCall?.args).toEqual({
          'input_required': JSON.stringify(data),
        });
        expect(event!.longRunningToolIds).toEqual(['mock-fc-id']);
      });
    });
  });
});
