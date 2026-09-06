/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  createEvent,
  createEventActions,
  getEventNodeName,
  getFunctionCalls,
  getFunctionResponses,
  getNodeInfoName,
  getNodeRunId,
  getParentNodeRunId,
  hasThoughts,
  hasTrailingCodeExecutionResult,
  InputValidationError,
  isFinalResponse,
  pruneThoughts,
  setEventMessage,
  stringifyContent,
} from '@google/adk';
import {Content, Outcome, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  createNewEventId,
  generateClientFunctionCallId,
  populateClientFunctionCallId,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../src/events/event.js';

describe('Event Utils', () => {
  describe('createEvent', () => {
    it('creates an event with default values', () => {
      const event = createEvent();
      expect(event.id).toBeDefined();
      expect(event.id.length).toBe(8);
      expect(event.invocationId).toBe('');
      expect(event.author).toBeUndefined();
      expect(event.actions).toBeDefined();
      expect(event.longRunningToolIds).toEqual([]);
      expect(event.branch).toBeUndefined();
      expect(event.timestamp).toBeDefined();
    });

    it('creates an event with provided values', () => {
      const timestamp = Date.now();
      const event = createEvent({
        id: 'test-id',
        invocationId: 'inv-id',
        author: 'user',
        branch: 'branch',
        timestamp,
      });

      expect(event.id).toBe('test-id');
      expect(event.invocationId).toBe('inv-id');
      expect(event.author).toBe('user');
      expect(event.branch).toBe('branch');
      expect(event.timestamp).toBe(timestamp);
    });
  });

  describe('isFinalResponse', () => {
    it('returns true if skipSummarization is set', () => {
      const event = createEvent({
        actions: createEventActions({skipSummarization: true}),
      });
      expect(isFinalResponse(event)).toBe(true);
    });

    it('returns true if longRunningToolIds is present and not empty', () => {
      const event = createEvent({
        longRunningToolIds: ['tool-id'],
      });
      expect(isFinalResponse(event)).toBe(true);
    });

    it('returns true if requestedAuthConfigs is present and not empty', () => {
      const event = createEvent({
        actions: createEventActions({
          requestedAuthConfigs: {
            'tool-id': {
              credentialKey: 'testKey',
            } as unknown as AuthConfig,
          },
        }),
      });
      expect(isFinalResponse(event)).toBe(true);
    });

    it('returns false if there are function calls', () => {
      const event = createEvent({
        content: {
          parts: [{functionCall: {name: 'func', args: {}}}],
        },
      });
      expect(isFinalResponse(event)).toBe(false);
    });

    it('returns false if there are function responses', () => {
      const event = createEvent({
        content: {
          parts: [{functionResponse: {name: 'func', response: {}}}],
        },
      });
      expect(isFinalResponse(event)).toBe(false);
    });

    it('returns false if event is partial', () => {
      const event = createEvent();
      event.partial = true;
      expect(isFinalResponse(event)).toBe(false);
    });

    it('returns false if there is a trailing code execution result', () => {
      const event = createEvent({
        content: {
          parts: [{codeExecutionResult: {outcome: Outcome.OUTCOME_OK}}],
        },
      });
      expect(isFinalResponse(event)).toBe(false);
    });

    it('returns true if none of the above conditions are met', () => {
      const event = createEvent();
      expect(isFinalResponse(event)).toBe(true);
    });
  });

  describe('getFunctionCalls', () => {
    it('returns empty array if no content or parts', () => {
      const event = createEvent();
      expect(getFunctionCalls(event)).toEqual([]);
    });

    it('returns function calls from parts', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'text'},
            {functionCall: {name: 'func1', args: {}}},
            {functionCall: {name: 'func2', args: {}}},
          ],
        },
      });
      expect(getFunctionCalls(event)).toHaveLength(2);
      expect(getFunctionCalls(event)[0].name).toBe('func1');
      expect(getFunctionCalls(event)[1].name).toBe('func2');
    });
  });

  describe('getFunctionResponses', () => {
    it('returns empty array if no content or parts', () => {
      const event = createEvent();
      expect(getFunctionResponses(event)).toEqual([]);
    });

    it('returns function responses from parts', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'text'},
            {functionResponse: {name: 'func1', response: {}}},
            {functionResponse: {name: 'func2', response: {}}},
          ],
        },
      });
      expect(getFunctionResponses(event)).toHaveLength(2);
      expect(getFunctionResponses(event)[0].name).toBe('func1');
      expect(getFunctionResponses(event)[1].name).toBe('func2');
    });
  });

  describe('hasTrailingCodeExecutionResult', () => {
    it('returns false if no content or parts', () => {
      const event = createEvent();
      expect(hasTrailingCodeExecutionResult(event)).toBe(false);
    });

    it('returns true if last part has codeExecutionResult', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'text'},
            {codeExecutionResult: {outcome: Outcome.OUTCOME_OK}},
          ],
        },
      });
      expect(hasTrailingCodeExecutionResult(event)).toBe(true);
    });

    it('returns false if last part does not have codeExecutionResult', () => {
      const event = createEvent({
        content: {
          parts: [
            {codeExecutionResult: {outcome: Outcome.OUTCOME_OK}},
            {text: 'text'},
          ],
        },
      });
      expect(hasTrailingCodeExecutionResult(event)).toBe(false);
    });
  });

  describe('stringifyContent', () => {
    it('returns empty string if no content or parts', () => {
      const event = createEvent();
      expect(stringifyContent(event)).toBe('');
    });

    it('concatenates text from all parts', () => {
      const event = createEvent({
        content: {
          parts: [{text: 'Hello'}, {text: ' '}, {text: 'World'}],
        },
      });
      expect(stringifyContent(event)).toBe('Hello World');
    });

    it('ignores parts without text', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'Hello'},
            {functionCall: {name: 'foo', args: {}}},
            {text: 'World'},
          ],
        },
      });
      expect(stringifyContent(event)).toBe('HelloWorld');
    });

    it('ignores parts marked as thought', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'reasoning about the user request', thought: true},
            {text: 'Hello'},
            {text: 'World'},
          ],
        },
      });
      expect(stringifyContent(event)).toBe('HelloWorld');
    });

    it('returns empty string when all parts are thoughts', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'first thought', thought: true},
            {text: 'second thought', thought: true},
          ],
        },
      });
      expect(stringifyContent(event)).toBe('');
    });
  });

  describe('hasThoughts', () => {
    it('returns false if no content or parts', () => {
      const event = createEvent();
      expect(hasThoughts(event)).toBe(false);
    });

    it('returns true if any part has thought === true', () => {
      const event = createEvent({
        content: {
          parts: [{text: 'hello'}, {text: 'thinking...', thought: true}],
        },
      });
      expect(hasThoughts(event)).toBe(true);
    });

    it('returns false if no part has thought === true', () => {
      const event = createEvent({
        content: {
          parts: [{text: 'hello'}, {text: 'world'}],
        },
      });
      expect(hasThoughts(event)).toBe(false);
    });
  });

  describe('pruneThoughts', () => {
    it('returns event unchanged if no content or parts', () => {
      const event = createEvent();
      expect(pruneThoughts(event)).toEqual(event);
    });

    it('removes parts with thought === true', () => {
      const event = createEvent({
        content: {
          parts: [
            {text: 'thinking...', thought: true},
            {text: 'hello'},
            {text: 'more thoughts', thought: true},
            {text: 'world'},
          ],
        },
      });
      const pruned = pruneThoughts(event);
      expect(pruned.content!.parts).toEqual([{text: 'hello'}, {text: 'world'}]);
    });
  });

  describe('createNewEventId', () => {
    it('generates an 8-character string', () => {
      const id = createNewEventId();
      expect(id).toHaveLength(8);
      expect(typeof id).toBe('string');
    });
  });

  describe('transformToCamelCaseEvent', () => {
    it('transforms snake_case event to camelCase', () => {
      const snakeEvent = {
        id: '123',
        invocation_id: 'inv1',
        actions: {
          state_delta: {some_key: 'value'},
        },
      };
      const camelEvent = transformToCamelCaseEvent(snakeEvent);
      expect(camelEvent.id).toBe('123');
      expect(camelEvent.invocationId).toBe('inv1');
      expect(camelEvent.actions?.stateDelta).toEqual({some_key: 'value'});
    });

    it('preserves customMetadata keys during conversion to camelCase', () => {
      const snakeEvent = {
        id: '123',
        invocation_id: 'inv1',
        custom_metadata: {
          'preserve-my-key': 'value',
          NestedKey: 'value2',
        },
      };
      const camelEvent = transformToCamelCaseEvent(snakeEvent);
      expect(camelEvent.customMetadata).toEqual({
        'preserve-my-key': 'value',
        NestedKey: 'value2',
      });
    });
  });

  describe('transformToSnakeCaseEvent', () => {
    it('transforms camelCase event to snake_case', () => {
      const camelEvent = createEvent({
        id: '123',
        invocationId: 'inv1',
        actions: createEventActions({
          stateDelta: {someKey: 'value'},
        }),
      });
      const snakeEvent = transformToSnakeCaseEvent(camelEvent);
      expect(snakeEvent.id).toBe('123');
      expect(snakeEvent.invocation_id).toBe('inv1');
      expect(
        (snakeEvent.actions as Record<string, unknown>).state_delta,
      ).toEqual({someKey: 'value'});
    });

    it('preserves customMetadata keys during conversion to snake_case', () => {
      const camelEvent = createEvent({
        id: '123',
        invocationId: 'inv1',
        customMetadata: {
          'preserve-my-key': 'value',
          NestedKey: 'value2',
        },
      });
      const snakeEvent = transformToSnakeCaseEvent(camelEvent);
      expect(snakeEvent.custom_metadata).toEqual({
        'preserve-my-key': 'value',
        NestedKey: 'value2',
      });
    });

    it('preserves workflow output and agentState keys verbatim', () => {
      const camelEvent = createEvent({
        id: '123',
        invocationId: 'inv1',
        output: {cityName: 'Paris', timeInfo: '10:10 AM'},
        actions: createEventActions({
          agentState: {input: {userId: 42, requestedItems: ['a']}},
        }),
      });
      const snakeEvent = transformToSnakeCaseEvent(camelEvent);
      // Arbitrary payloads must NOT be snake_cased.
      expect(snakeEvent.output).toEqual({
        cityName: 'Paris',
        timeInfo: '10:10 AM',
      });
      expect(
        (snakeEvent.actions as Record<string, unknown>).agent_state,
      ).toEqual({input: {userId: 42, requestedItems: ['a']}});
    });
  });

  describe('event round-trip serialization', () => {
    it('round-trips workflow output and agentState without mangling keys', () => {
      const original = createEvent({
        id: '123',
        invocationId: 'inv1',
        output: {cityName: 'Paris', nested: {timeInfo: '10:10 AM'}},
        route: ['BUG', 'LOGISTICS'],
        actions: createEventActions({
          agentState: {input: {userId: 42, camelKey: 'v'}},
        }),
      });
      const restored = transformToCamelCaseEvent(
        transformToSnakeCaseEvent(original),
      );
      expect(restored.output).toEqual({
        cityName: 'Paris',
        nested: {timeInfo: '10:10 AM'},
      });
      expect(restored.route).toEqual(['BUG', 'LOGISTICS']);
      expect(restored.actions?.agentState).toEqual({
        input: {userId: 42, camelKey: 'v'},
      });
    });
  });

  describe('generateClientFunctionCallId', () => {
    it('should generate a valid ID with prefix', () => {
      const id = generateClientFunctionCallId();
      expect(id).toMatch(/^adk-/);
    });
  });

  describe('populateClientFunctionCallId', () => {
    it('should populate ID if missing', () => {
      const event = createEvent({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'testTool', args: {}}}],
        },
      });
      populateClientFunctionCallId(event);
      expect(event.content!.parts![0].functionCall!.id).toBeDefined();
      expect(event.content!.parts![0].functionCall!.id).toMatch(/^adk-/);
    });

    it('should not overwrite existing ID', () => {
      const event = createEvent({
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'testTool', args: {}, id: 'existing-id'}},
          ],
        },
      });
      populateClientFunctionCallId(event);
      expect(event.content!.parts![0].functionCall!.id).toBe('existing-id');
    });

    it('should handle event with no function calls', () => {
      const event = createEvent({
        content: {
          role: 'model',
          parts: [{text: 'hello'}],
        },
      });
      populateClientFunctionCallId(event);
      expect(event.content!.parts![0].text).toBe('hello');
    });
  });
});

describe('createEvent convenience kwargs', () => {
  describe('message', () => {
    it('builds content from a string', () => {
      const event = createEvent({author: 'user', message: 'Hello!'});
      expect(event.content).toEqual({role: 'user', parts: [{text: 'Hello!'}]});
    });

    it('passes a Content through by identity', () => {
      const content: Content = {role: 'model', parts: [{text: 'hi'}]};
      const event = createEvent({message: content});
      expect(event.content).toBe(content);
    });

    it('converts a single part', () => {
      const part: Part = {text: 'one'};
      expect(createEvent({message: part}).content).toEqual({
        role: 'user',
        parts: [part],
      });
    });

    it('converts a part list preserving order', () => {
      const parts: Part[] = [{text: 'a'}, {text: 'b'}];
      expect(createEvent({message: parts}).content).toEqual({
        role: 'user',
        parts,
      });
    });

    it('rejects message together with content', () => {
      expect(() =>
        createEvent({message: 'hi', content: {parts: [{text: 'world'}]}}),
      ).toThrow(InputValidationError);
      expect(() =>
        createEvent({message: 'hi', content: {parts: [{text: 'world'}]}}),
      ).toThrow(/mutually exclusive/);
    });

    it('still accepts content on its own', () => {
      const content: Content = {role: 'user', parts: [{text: 'only'}]};
      expect(createEvent({content}).content).toBe(content);
    });

    it('leaves content undefined when neither is given', () => {
      expect(createEvent({author: 'user'}).content).toBeUndefined();
    });
  });

  describe('state', () => {
    it('lands on actions.stateDelta', () => {
      const event = createEvent({author: 'a', state: {k: 'v'}});
      expect(event.actions.stateDelta).toEqual({k: 'v'});
    });

    it('leaves stateDelta empty when omitted', () => {
      expect(createEvent({author: 'a'}).actions.stateDelta).toEqual({});
    });

    it('keeps the other action fields when actions is also given', () => {
      const event = createEvent({
        state: {k: 'v'},
        actions: {escalate: true, transferToAgent: 'other'},
      });
      expect(event.actions.stateDelta).toEqual({k: 'v'});
      expect(event.actions.escalate).toBe(true);
      expect(event.actions.transferToAgent).toBe('other');
    });
  });

  describe('nodePath', () => {
    it('lands on nodeInfo.path', () => {
      expect(createEvent({nodePath: 'root.n'}).nodeInfo).toEqual({
        path: 'root.n',
      });
    });

    it('keeps the other nodeInfo fields when nodeInfo is also given', () => {
      const event = createEvent({
        nodePath: 'root.n',
        nodeInfo: {path: 'stale', outputFor: ['root'], messageAsOutput: true},
      });
      expect(event.nodeInfo).toEqual({
        path: 'root.n',
        outputFor: ['root'],
        messageAsOutput: true,
      });
    });

    it('leaves nodeInfo undefined when neither is given', () => {
      expect(createEvent({author: 'a'}).nodeInfo).toBeUndefined();
    });
  });

  describe('combined', () => {
    it('routes message and state together', () => {
      const event = createEvent({message: 'hi', state: {k: 'v'}});
      expect(event.content!.parts![0].text).toBe('hi');
      expect(event.actions.stateDelta).toEqual({k: 'v'});
    });

    it('routes message and nodePath together', () => {
      const event = createEvent({message: 'hi', nodePath: 'wf@1.n@2'});
      expect(event.content!.parts![0].text).toBe('hi');
      expect(event.nodeInfo!.path).toBe('wf@1.n@2');
    });
  });

  it('does not copy the convenience keys onto the event', () => {
    const event = createEvent({
      message: 'hi',
      state: {k: 'v'},
      nodePath: 'root.n',
    });
    expect(Object.keys(event)).not.toContain('message');
    expect(Object.keys(event)).not.toContain('state');
    expect(Object.keys(event)).not.toContain('nodePath');
  });

  it('serializes the message under content', () => {
    const serialized = transformToSnakeCaseEvent(
      createEvent({message: 'hi', state: {k: 'v'}, nodePath: 'root.n'}),
    );
    expect(serialized['content']).toEqual({
      role: 'user',
      parts: [{text: 'hi'}],
    });
    expect(serialized).not.toHaveProperty('message');
    expect(serialized).not.toHaveProperty('node_path');
    expect(serialized['node_info']).toEqual({path: 'root.n'});
  });

  it('does not mutate the params object', () => {
    const params = {
      author: 'a',
      message: 'hi',
      state: {k: 'v'},
      nodePath: 'root.n',
      actions: {escalate: true},
    };
    const before = structuredClone(params);
    createEvent(params);
    expect(params).toEqual(before);
  });
});

describe('setEventMessage', () => {
  it('rebuilds content from a string', () => {
    const event = createEvent({message: 'first'});
    setEventMessage(event, 'updated');
    expect(event.content).toEqual({role: 'user', parts: [{text: 'updated'}]});
  });

  it('stores a Content by identity', () => {
    const event = createEvent({author: 'a'});
    const content: Content = {role: 'model', parts: [{text: 'x'}]};
    setEventMessage(event, content);
    expect(event.content).toBe(content);
  });

  it('clears the content for undefined and null', () => {
    const event = createEvent({message: 'first'});
    setEventMessage(event, undefined);
    expect(event.content).toBeUndefined();

    setEventMessage(event, 'again');
    setEventMessage(event, null);
    expect(event.content).toBeUndefined();
  });
});

describe('node identity accessors', () => {
  it('derives the run id, parent run id and name from the path', () => {
    const event = createEvent({author: 'a', nodePath: 'wf@1.review@3'});
    expect(getNodeRunId(event.nodeInfo)).toBe('3');
    expect(getParentNodeRunId(event.nodeInfo)).toBe('1');
    expect(getNodeInfoName(event.nodeInfo)).toBe('review');
  });

  it('reads a path written with the Python separator', () => {
    const event = createEvent({author: 'a', nodePath: 'wf@1/review@3'});
    expect(getNodeRunId(event.nodeInfo)).toBe('3');
    expect(getParentNodeRunId(event.nodeInfo)).toBe('1');
    expect(getNodeInfoName(event.nodeInfo)).toBe('review');
  });

  it('degrades on a path with no run ids', () => {
    const event = createEvent({author: 'a', nodePath: 'wf.review'});
    expect(getNodeRunId(event.nodeInfo)).toBe('');
    expect(getParentNodeRunId(event.nodeInfo)).toBeUndefined();
    expect(getNodeInfoName(event.nodeInfo)).toBe('review');
  });

  it('degrades on an event with no nodeInfo', () => {
    const event = createEvent({author: 'a'});
    expect(getNodeRunId(event.nodeInfo)).toBe('');
    expect(getParentNodeRunId(event.nodeInfo)).toBeUndefined();
    expect(getNodeInfoName(event.nodeInfo)).toBe('');
  });
});

describe('getEventNodeName', () => {
  it('returns the leaf node name for a plain node event', () => {
    expect(getEventNodeName(createEvent({nodePath: 'wf@1.review@3'}))).toBe(
      'review',
    );
  });

  it('returns an empty string when the event ends an agent', () => {
    const event = createEvent({
      nodePath: 'wf@1.review@3',
      actions: {endOfAgent: true},
    });
    expect(getEventNodeName(event)).toBe('');
  });

  it('returns an empty string when the event carries agent state', () => {
    const event = createEvent({
      nodePath: 'wf@1.review@3',
      actions: {agentState: {step: 1}},
    });
    expect(getEventNodeName(event)).toBe('');
  });

  it('keeps the node name when agentState is empty', () => {
    const event = createEvent({
      nodePath: 'wf@1.review@3',
      actions: {agentState: {}},
    });
    expect(getEventNodeName(event)).toBe('review');
  });

  it('returns an empty string when the event has no nodeInfo', () => {
    expect(getEventNodeName(createEvent({author: 'a'}))).toBe('');
  });
});

describe('longRunningToolIds serialization', () => {
  it('sorts the ids', () => {
    const serialized = transformToSnakeCaseEvent(
      createEvent({longRunningToolIds: ['zzz', 'aaa', 'mmm']}),
    );
    expect(serialized['long_running_tool_ids']).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('collapses duplicates', () => {
    const serialized = transformToSnakeCaseEvent(
      createEvent({longRunningToolIds: ['zzz', 'aaa', 'aaa']}),
    );
    expect(serialized['long_running_tool_ids']).toEqual(['aaa', 'zzz']);
  });

  it('does not mutate the event array', () => {
    const event = createEvent({longRunningToolIds: ['zzz', 'aaa']});
    transformToSnakeCaseEvent(event);
    expect(event.longRunningToolIds).toEqual(['zzz', 'aaa']);
  });

  it('keeps an empty array empty', () => {
    const serialized = transformToSnakeCaseEvent(createEvent({}));
    expect(serialized['long_running_tool_ids']).toEqual([]);
  });

  it('does not invent an absent value', () => {
    const event = createEvent({});
    delete event.longRunningToolIds;
    const serialized = transformToSnakeCaseEvent(event);
    expect(serialized['long_running_tool_ids']).toBeUndefined();
  });

  it('restores the ids on a round trip', () => {
    const serialized = transformToSnakeCaseEvent(
      createEvent({longRunningToolIds: ['zzz', 'aaa']}),
    );
    const restored = transformToCamelCaseEvent(serialized);
    expect(restored.longRunningToolIds).toEqual(['aaa', 'zzz']);
  });
});
