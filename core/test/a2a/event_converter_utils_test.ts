/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {RequestContext} from '@a2a-js/sdk/server';
import {
  Event as AdkEvent,
  createEvent,
  createEventActions,
  ExecutorContext,
} from '@google/adk';
import {Part as GenAIPart} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {A2AEvent} from '../../src/a2a/a2a_event.js';
import {
  statusUpdateToAdkEvent,
  toA2AArtifactUpdateEvent,
  toA2AMessage,
  toAdkEvent,
} from '../../src/a2a/event_converter_utils.js';
import {toGenAIPart} from '../../src/a2a/part_converter_utils.js';
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

  describe('toA2AArtifactUpdateEvent', () => {
    const executorContext: ExecutorContext = {
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'test-session',
      readonlyState: {},
      events: [],
      userContent: {role: 'user', parts: [{text: 'hello'}]},
      requestContext: new RequestContext(
        {
          kind: 'message',
          messageId: 'message-1',
          role: 'user',
          parts: [{kind: 'text', text: 'hello'}],
        },
        'task-1',
        'ctx-1',
      ),
    };

    const streamedEvent = (text: string, partial: boolean) =>
      createEvent({
        invocationId: 'inv1',
        author: 'agent1',
        content: {role: 'model', parts: [{text}]},
        partial,
      });

    it('returns undefined when the ADK event has no parts', () => {
      const partialArtifactIds: Record<string, string> = {};

      expect(
        toA2AArtifactUpdateEvent(
          createEvent({invocationId: 'inv1', author: 'agent1'}),
          executorContext,
          partialArtifactIds,
        ),
      ).toBe(undefined);
      expect(partialArtifactIds).toEqual({});
    });

    it('marks a partial event for appending and records its artifact id', () => {
      vi.mocked(envAwareUtils.randomUUID).mockReturnValue('artifact-1');
      const partialArtifactIds: Record<string, string> = {};

      const event = toA2AArtifactUpdateEvent(
        streamedEvent('chunk 1', true),
        executorContext,
        partialArtifactIds,
      );

      expect(event).toMatchObject({
        kind: 'artifact-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        append: true,
        lastChunk: false,
        artifact: {
          artifactId: 'artifact-1',
          parts: [{kind: 'text', text: 'chunk 1'}],
        },
      });
      expect(partialArtifactIds).toEqual({'agent1': 'artifact-1'});
    });

    it('reuses the recorded artifact id for a following partial event', () => {
      vi.mocked(envAwareUtils.randomUUID).mockReturnValue('unused-artifact');
      const partialArtifactIds: Record<string, string> = {
        'agent1': 'artifact-1',
      };

      const event = toA2AArtifactUpdateEvent(
        streamedEvent('chunk 2', true),
        executorContext,
        partialArtifactIds,
      );

      expect(event!.artifact.artifactId).toBe('artifact-1');
      expect(partialArtifactIds).toEqual({'agent1': 'artifact-1'});
    });

    it('closes the artifact and forgets its id on a non-partial event', () => {
      const partialArtifactIds: Record<string, string> = {
        'agent1': 'artifact-1',
      };

      const event = toA2AArtifactUpdateEvent(
        streamedEvent('last chunk', false),
        executorContext,
        partialArtifactIds,
      );

      expect(event).toMatchObject({
        append: false,
        lastChunk: true,
        artifact: {artifactId: 'artifact-1'},
      });
      expect(partialArtifactIds).toEqual({});
    });

    it('applies a custom part converter to every part', () => {
      vi.mocked(envAwareUtils.randomUUID).mockReturnValue('artifact-2');

      const event = toA2AArtifactUpdateEvent(
        createEvent({
          invocationId: 'inv1',
          author: 'agent1',
          content: {role: 'model', parts: [{text: 'first'}, {text: 'second'}]},
          partial: false,
        }),
        executorContext,
        {},
        (part) => ({kind: 'text', text: `converted:${part.text}`}),
      );

      expect(event!.artifact.parts).toEqual([
        {kind: 'text', text: 'converted:first'},
        {kind: 'text', text: 'converted:second'},
      ]);
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
    });
  });

  describe('converter overrides', () => {
    const message: Message = {
      kind: 'message',
      messageId: 'msg-override',
      role: 'agent',
      parts: [{kind: 'text', text: 'hello'}],
    };

    const task: Task = {
      kind: 'task',
      id: 'task-override',
      contextId: 'ctx-override',
      status: {
        state: 'completed',
        message: {
          kind: 'message',
          messageId: 'msg-in-task',
          role: 'agent',
          parts: [{kind: 'text', text: 'from task'}],
        },
      },
    };

    const artifactUpdate: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: 'task-override',
      contextId: 'ctx-override',
      artifact: {
        artifactId: 'art-override',
        parts: [{kind: 'text', text: 'from artifact'}],
      },
    };

    const statusUpdate: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: 'task-override',
      contextId: 'ctx-override',
      status: {
        state: 'working',
        message: {
          kind: 'message',
          messageId: 'msg-in-status',
          role: 'agent',
          parts: [{kind: 'text', text: 'from status'}],
        },
      },
      final: false,
    };

    const upperCasePartConverter = (a2aPart: A2APart): GenAIPart => {
      const genAIPart = toGenAIPart(a2aPart);
      return genAIPart.text
        ? {...genAIPart, text: genAIPart.text.toUpperCase()}
        : genAIPart;
    };

    it('routes a Message to a2aMessageConverter', () => {
      const converted = createEvent({author: 'agent1', invocationId: 'inv1'});
      const a2aMessageConverter = vi.fn().mockReturnValue(converted);
      const a2aPartConverter = vi.fn(toGenAIPart);

      const event = toAdkEvent(message, 'inv1', 'agent1', 'branch1', {
        a2aMessageConverter,
        a2aPartConverter,
      });

      expect(event).toBe(converted);
      expect(a2aMessageConverter).toHaveBeenCalledTimes(1);
      expect(a2aMessageConverter).toHaveBeenCalledWith(
        message,
        'inv1',
        'agent1',
        'branch1',
        a2aPartConverter,
      );
    });

    it('routes a Task to a2aTaskConverter', () => {
      const converted = createEvent({author: 'agent1', invocationId: 'inv1'});
      const a2aTaskConverter = vi.fn().mockReturnValue(converted);
      const a2aPartConverter = vi.fn(toGenAIPart);

      const event = toAdkEvent(task, 'inv1', 'agent1', 'branch1', {
        a2aTaskConverter,
        a2aPartConverter,
      });

      expect(event).toBe(converted);
      expect(a2aTaskConverter).toHaveBeenCalledTimes(1);
      expect(a2aTaskConverter).toHaveBeenCalledWith(
        task,
        'inv1',
        'agent1',
        'branch1',
        a2aPartConverter,
      );
    });

    it('routes an artifact update to a2aArtifactUpdateConverter', () => {
      const converted = createEvent({author: 'agent1', invocationId: 'inv1'});
      const a2aArtifactUpdateConverter = vi.fn().mockReturnValue(converted);
      const a2aPartConverter = vi.fn(toGenAIPart);

      const event = toAdkEvent(artifactUpdate, 'inv1', 'agent1', 'branch1', {
        a2aArtifactUpdateConverter,
        a2aPartConverter,
      });

      expect(event).toBe(converted);
      expect(a2aArtifactUpdateConverter).toHaveBeenCalledTimes(1);
      expect(a2aArtifactUpdateConverter).toHaveBeenCalledWith(
        artifactUpdate,
        'inv1',
        'agent1',
        'branch1',
        a2aPartConverter,
      );
    });

    it('routes a status update to a2aStatusUpdateConverter', () => {
      const converted = createEvent({author: 'agent1', invocationId: 'inv1'});
      const a2aStatusUpdateConverter = vi.fn().mockReturnValue(converted);
      const a2aPartConverter = vi.fn(toGenAIPart);

      const event = toAdkEvent(statusUpdate, 'inv1', 'agent1', 'branch1', {
        a2aStatusUpdateConverter,
        a2aPartConverter,
      });

      expect(event).toBe(converted);
      expect(a2aStatusUpdateConverter).toHaveBeenCalledTimes(1);
      expect(a2aStatusUpdateConverter).toHaveBeenCalledWith(
        statusUpdate,
        'inv1',
        'agent1',
        'branch1',
        a2aPartConverter,
      );
    });

    it('does not route a Message to the Task converter', () => {
      const a2aTaskConverter = vi.fn();

      const event = toAdkEvent(message, 'inv1', 'agent1', undefined, {
        a2aTaskConverter,
      });

      expect(a2aTaskConverter).not.toHaveBeenCalled();
      expect(event!.content?.parts).toEqual([{text: 'hello', thought: false}]);
    });

    it('emits no event when an override returns undefined', () => {
      const a2aStatusUpdateConverter = vi.fn().mockReturnValue(undefined);

      const event = toAdkEvent(statusUpdate, 'inv1', 'agent1', undefined, {
        a2aStatusUpdateConverter,
      });

      expect(event).toBeUndefined();
      expect(a2aStatusUpdateConverter).toHaveBeenCalledTimes(1);
    });

    it('returns undefined for an unknown kind even with converters supplied', () => {
      const a2aMessageConverter = vi.fn();
      const a2aTaskConverter = vi.fn();

      const event = toAdkEvent(
        {kind: 'unknown'} as unknown as A2AEvent,
        'inv1',
        'agent1',
        undefined,
        {a2aMessageConverter, a2aTaskConverter},
      );

      expect(event).toBeUndefined();
      expect(a2aMessageConverter).not.toHaveBeenCalled();
      expect(a2aTaskConverter).not.toHaveBeenCalled();
    });

    it('reaches the built-in Message converter with a2aPartConverter alone', () => {
      const event = toAdkEvent(message, 'inv1', 'agent1', undefined, {
        a2aPartConverter: upperCasePartConverter,
      });

      expect(event!.content?.parts).toEqual([{text: 'HELLO', thought: false}]);
    });

    it('reaches the built-in Task converter with a2aPartConverter alone', () => {
      const taskWithArtifact: Task = {
        ...task,
        artifacts: [
          {
            artifactId: 'art-in-task',
            parts: [{kind: 'text', text: 'from artifact'}],
          },
        ],
      };

      const event = toAdkEvent(taskWithArtifact, 'inv1', 'agent1', undefined, {
        a2aPartConverter: upperCasePartConverter,
      });

      expect(event!.content?.parts).toEqual([
        {text: 'FROM ARTIFACT', thought: false},
        {text: 'FROM TASK', thought: false},
      ]);
    });

    it('reaches the built-in artifact update converter with a2aPartConverter alone', () => {
      const event = toAdkEvent(artifactUpdate, 'inv1', 'agent1', undefined, {
        a2aPartConverter: upperCasePartConverter,
      });

      expect(event!.content?.parts).toEqual([
        {text: 'FROM ARTIFACT', thought: false},
      ]);
    });

    it('reaches the built-in partial status update converter with a2aPartConverter alone', () => {
      const event = toAdkEvent(statusUpdate, 'inv1', 'agent1', undefined, {
        a2aPartConverter: upperCasePartConverter,
      });

      expect(event!.content?.parts).toEqual([
        {text: 'FROM STATUS', thought: false},
      ]);
    });

    it('reaches the built-in final status update converter with a2aPartConverter alone', () => {
      const event = toAdkEvent(
        {...statusUpdate, final: true},
        'inv1',
        'agent1',
        undefined,
        {a2aPartConverter: upperCasePartConverter},
      );

      expect(event!.content?.parts).toEqual([
        {text: 'FROM STATUS', thought: false},
      ]);
      expect(event!.turnComplete).toBe(true);
    });

    it('uses a2aPartConverter to detect long-running tool ids', () => {
      const longRunningUpdate: TaskArtifactUpdateEvent = {
        kind: 'artifact-update',
        taskId: 'task-override',
        contextId: 'ctx-override',
        artifact: {
          artifactId: 'art-long-running',
          parts: [
            {
              kind: 'data',
              data: {id: 'origTool', name: 'origTool', args: {}},
              metadata: {
                'adk_is_long_running': true,
                'adk_type': 'function_call',
              },
            },
          ],
        },
      };
      const renamingPartConverter = (a2aPart: A2APart): GenAIPart => {
        const genAIPart = toGenAIPart(a2aPart);
        return genAIPart.functionCall
          ? {
              ...genAIPart,
              functionCall: {...genAIPart.functionCall, id: 'renamedTool'},
            }
          : genAIPart;
      };

      const event = toAdkEvent(longRunningUpdate, 'inv1', 'agent1', undefined, {
        a2aPartConverter: renamingPartConverter,
      });

      expect(event!.longRunningToolIds).toEqual(['renamedTool']);
    });

    it('uses a2aPartConverter to detect long-running tool ids on a Task', () => {
      const longRunningTask: Task = {
        kind: 'task',
        id: 'task-long-running',
        contextId: 'ctx-override',
        status: {
          state: 'completed',
          message: {
            kind: 'message',
            messageId: 'msg-long-running',
            role: 'agent',
            parts: [
              {
                kind: 'data',
                data: {id: 'statusTool', name: 'statusTool', args: {}},
                metadata: {
                  'adk_is_long_running': true,
                  'adk_type': 'function_call',
                },
              },
            ],
          },
        },
        artifacts: [
          {
            artifactId: 'art-long-running',
            parts: [
              {
                kind: 'data',
                data: {id: 'artifactTool', name: 'artifactTool', args: {}},
                metadata: {
                  'adk_is_long_running': true,
                  'adk_type': 'function_call',
                },
              },
            ],
          },
        ],
      };
      const prefixingPartConverter = (a2aPart: A2APart): GenAIPart => {
        const genAIPart = toGenAIPart(a2aPart);
        return genAIPart.functionCall
          ? {
              ...genAIPart,
              functionCall: {
                ...genAIPart.functionCall,
                id: `pre-${genAIPart.functionCall.id}`,
              },
            }
          : genAIPart;
      };

      const event = toAdkEvent(longRunningTask, 'inv1', 'agent1', undefined, {
        a2aPartConverter: prefixingPartConverter,
      });

      expect(event!.longRunningToolIds).toEqual([
        'pre-artifactTool',
        'pre-statusTool',
      ]);
    });

    it('produces the default event when no converter is supplied', () => {
      // `id` and `timestamp` are minted per call, so they never match across
      // two conversions of the same input.
      const stable = (event: AdkEvent | undefined) =>
        event && {...event, id: 'stable', timestamp: 0};

      for (const a2aEvent of [message, task, artifactUpdate, statusUpdate]) {
        expect(
          stable(toAdkEvent(a2aEvent, 'inv1', 'agent1', 'branch1', {})),
        ).toEqual(stable(toAdkEvent(a2aEvent, 'inv1', 'agent1', 'branch1')));
      }
    });
  });

  describe('statusUpdateToAdkEvent', () => {
    const baseStatusUpdate: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: 'task-dispatch',
      contextId: 'ctx-dispatch',
      status: {
        state: 'working',
        message: {
          kind: 'message',
          messageId: 'msg-dispatch',
          role: 'agent',
          parts: [{kind: 'text', text: 'progress'}],
        },
      },
      final: false,
    };

    it('produces a terminal event when final is true', () => {
      const event = statusUpdateToAdkEvent(
        {...baseStatusUpdate, final: true},
        'inv1',
        'agent1',
      );

      expect(event!.turnComplete).toBe(true);
      expect(event!.partial).toBeUndefined();
    });

    it('produces a partial event when final is false', () => {
      const event = statusUpdateToAdkEvent(baseStatusUpdate, 'inv1', 'agent1');

      expect(event!.turnComplete).toBe(false);
      expect(event!.partial).toBe(true);
    });
  });
});
