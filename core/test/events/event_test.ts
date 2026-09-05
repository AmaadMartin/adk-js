/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  createEvent,
  createEventActions,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  getNodeName,
  getNodePathName,
  getNodeRunId,
  getParentNodeRunId,
  hasThoughts,
  hasTrailingCodeExecutionResult,
  InputValidationError,
  isDefaultNodeInfo,
  isFinalResponse,
  pruneThoughts,
  setEventMessage,
  stringifyContent,
} from '@google/adk';
import {Content, Outcome} from '@google/genai';
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

describe('node info accessors', () => {
  it('reads the run id off an event node path', () => {
    const event = createEvent({nodePath: 'wf@1.reviewer@2'});
    expect(getNodeRunId(event.nodeInfo)).toBe('2');
  });

  it('reads the parent run id off an event node path', () => {
    const event = createEvent({nodePath: 'wf@1.reviewer@2'});
    expect(getParentNodeRunId(event.nodeInfo)).toBe('1');
  });

  it('reads the clean node name off an event node path', () => {
    const event = createEvent({nodePath: 'wf@1.reviewer@2'});
    expect(getNodePathName(event.nodeInfo)).toBe('reviewer');
  });

  it('returns the defaults for an absent node info', () => {
    expect(getNodeRunId(undefined)).toBe('');
    expect(getParentNodeRunId(undefined)).toBeUndefined();
    expect(getNodePathName(undefined)).toBe('');
  });
});

describe('getNodeName', () => {
  it('returns the leaf node name', () => {
    const event = createEvent({nodePath: 'wf@1.reviewer@2'});
    expect(getNodeName(event)).toBe('reviewer');
  });

  it('returns an empty string when the event ends an agent', () => {
    const event = createEvent({
      nodePath: 'wf@1.reviewer@2',
      actions: {endOfAgent: true},
    });
    expect(getNodeName(event)).toBe('');
  });

  it('returns an empty string when the event carries an agent state', () => {
    const event = createEvent({
      nodePath: 'wf@1.reviewer@2',
      actions: {agentState: {cursor: 3}},
    });
    expect(getNodeName(event)).toBe('');
  });

  it('returns the name when the agent state is empty', () => {
    const event = createEvent({
      nodePath: 'wf@1.reviewer@2',
      actions: {agentState: {}},
    });
    expect(getNodeName(event)).toBe('reviewer');
  });
});

describe('createEvent message parameter', () => {
  it('converts a string to content', () => {
    const event = createEvent({message: 'Hello!'});
    expect(event.content!.parts![0].text).toBe('Hello!');
  });

  it('passes a Content through by identity', () => {
    const content: Content = {role: 'model', parts: [{text: 'from Content'}]};
    const event = createEvent({message: content});
    expect(event.content).toBe(content);
  });

  it('converts a part to content', () => {
    const event = createEvent({message: {text: 'from Part'}});
    expect(event.content!.parts![0].text).toBe('from Part');
  });

  it('converts a list of parts to content', () => {
    const event = createEvent({message: [{text: 'part1'}, {text: 'part2'}]});
    expect(event.content!.parts).toHaveLength(2);
    expect(event.content!.parts![1].text).toBe('part2');
  });

  it('rejects message and content together', () => {
    expect(() =>
      createEvent({message: 'hello', content: {parts: [{text: 'world'}]}}),
    ).toThrow(InputValidationError);
    expect(() =>
      createEvent({message: 'hello', content: {parts: [{text: 'world'}]}}),
    ).toThrow(/mutually exclusive/);
  });

  it('still accepts content on its own', () => {
    const content: Content = {role: 'model', parts: [{text: 'via content'}]};
    const event = createEvent({content});
    expect(event.content).toBe(content);
  });

  it('leaves content undefined when neither is given', () => {
    expect(createEvent().content).toBeUndefined();
  });
});

describe('setEventMessage', () => {
  it('sets a Content unchanged', () => {
    const event = createEvent();
    const content: Content = {role: 'model', parts: [{text: 'updated'}]};
    setEventMessage(event, content);
    expect(event.content).toBe(content);
  });

  it('converts a string', () => {
    const event = createEvent();
    setEventMessage(event, 'updated via setter');
    expect(event.content!.parts![0].text).toBe('updated via setter');
  });

  it('clears the content when set to undefined', () => {
    const event = createEvent({message: 'hello'});
    setEventMessage(event, undefined);
    expect(event.content).toBeUndefined();
  });

  it('clears the content when set to null', () => {
    const event = createEvent({message: 'hello'});
    setEventMessage(event, null);
    expect(event.content).toBeUndefined();
  });
});

describe('event message serialization', () => {
  it('keeps the value under content, never under message', () => {
    const event = createEvent({message: 'Hello!'});
    expect('message' in event).toBe(false);

    const snake = transformToSnakeCaseEvent(event);
    expect(snake['message']).toBeUndefined();
    expect(snake['content']).toEqual({role: 'user', parts: [{text: 'Hello!'}]});
  });

  it('preserves the text across a snake-case round trip', () => {
    const event = createEvent({message: 'Hello!'});
    const restored = transformToCamelCaseEvent(
      transformToSnakeCaseEvent(event),
    );
    expect(restored.content!.parts![0].text).toBe('Hello!');
  });
});

describe('createEvent convenience kwargs', () => {
  it('routes state to the state delta', () => {
    const event = createEvent({state: {key: 'value'}});
    expect(event.actions.stateDelta).toEqual({key: 'value'});
  });

  it('keeps the other action fields alongside state', () => {
    const event = createEvent({
      state: {key: 'value'},
      actions: {escalate: true},
    });
    expect(event.actions.stateDelta).toEqual({key: 'value'});
    expect(event.actions.escalate).toBe(true);
  });

  it('leaves the state delta empty without state', () => {
    expect(createEvent().actions.stateDelta).toEqual({});
  });

  it('routes nodePath to the node info path', () => {
    const event = createEvent({nodePath: 'root.node'});
    expect(event.nodeInfo).toEqual({path: 'root.node'});
  });

  it('preserves the other node info fields alongside nodePath', () => {
    const event = createEvent({
      nodePath: 'root.node',
      nodeInfo: {outputFor: ['root']},
    });
    expect(event.nodeInfo).toEqual({outputFor: ['root'], path: 'root.node'});
  });

  it('still passes route through to the event', () => {
    expect(createEvent({route: 'next'}).route).toBe('next');
  });

  it('accepts message and state together', () => {
    const event = createEvent({message: 'hello', state: {key: 'val'}});
    expect(event.content!.parts![0].text).toBe('hello');
    expect(event.actions.stateDelta).toEqual({key: 'val'});
  });

  it('does not mutate the params it was given', () => {
    const params = {
      message: 'Hello!',
      state: {key: 'value'},
      route: 'next',
      nodePath: 'root.node',
      actions: {escalate: true},
      nodeInfo: {outputFor: ['root']},
    };
    const original = structuredClone(params);

    const event = createEvent(params);

    expect(params).toEqual(original);
    expect(event.content!.parts![0].text).toBe('Hello!');
    expect(event.actions.stateDelta).toEqual({key: 'value'});
    expect(event.route).toBe('next');
    expect(event.nodeInfo!.path).toBe('root.node');
  });
});

describe('long running tool id serialization', () => {
  it('emits the ids deduplicated and sorted', () => {
    const event = createEvent({
      author: 'user',
      longRunningToolIds: ['zzz', 'aaa', 'mmm', 'aaa'],
    });

    expect(transformToSnakeCaseEvent(event)['long_running_tool_ids']).toEqual([
      'aaa',
      'mmm',
      'zzz',
    ]);
  });

  it('serializes the same event identically every time', () => {
    const event = createEvent({
      author: 'user',
      longRunningToolIds: ['call_2', 'call_1'],
    });

    expect(JSON.stringify(transformToSnakeCaseEvent(event))).toBe(
      JSON.stringify(transformToSnakeCaseEvent(event)),
    );
  });

  it('leaves an undefined field out of the output', () => {
    const event: Event = {
      id: 'e1',
      invocationId: 'inv',
      actions: createEventActions(),
      timestamp: 1,
    };

    expect('long_running_tool_ids' in transformToSnakeCaseEvent(event)).toBe(
      false,
    );
  });

  it('keeps an empty list empty', () => {
    const event = createEvent({author: 'user', longRunningToolIds: []});

    expect(transformToSnakeCaseEvent(event)['long_running_tool_ids']).toEqual(
      [],
    );
  });
});

describe('nodeInfo default', () => {
  it('defaults nodeInfo on a created event', () => {
    expect(createEvent().nodeInfo).toEqual({path: ''});
  });

  it('preserves an explicit nodeInfo verbatim', () => {
    const nodeInfo = {path: 'wf.node', messageAsOutput: true};
    expect(createEvent({nodeInfo}).nodeInfo).toBe(nodeInfo);
  });

  it('reports the default nodeInfo as default', () => {
    expect(isDefaultNodeInfo(createEvent().nodeInfo!)).toBe(true);
  });

  it('reports a nodeInfo with a path as non-default', () => {
    expect(isDefaultNodeInfo({path: 'wf.node'})).toBe(false);
  });

  it('reports a nodeInfo with an outputFor as non-default', () => {
    expect(isDefaultNodeInfo({outputFor: ['wf.node']})).toBe(false);
  });

  it('reports a nodeInfo with messageAsOutput as non-default', () => {
    expect(isDefaultNodeInfo({messageAsOutput: false})).toBe(false);
  });

  it('reports an empty outputFor as default', () => {
    expect(isDefaultNodeInfo({path: '', outputFor: []})).toBe(true);
  });
});
