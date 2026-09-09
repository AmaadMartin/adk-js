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
  getEventMessage,
  getFunctionCalls,
  getFunctionResponses,
  getNodeName,
  getNodePathName,
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
  describe('getNodeRunId', () => {
    it('returns the run id of the leaf segment', () => {
      expect(getNodeRunId({path: 'wf@1.node@2'})).toBe('2');
    });

    it('returns an empty string when the leaf carries no run id', () => {
      expect(getNodeRunId({path: 'node'})).toBe('');
    });

    it('returns an empty string for an empty or absent path', () => {
      expect(getNodeRunId({path: ''})).toBe('');
      expect(getNodeRunId({})).toBe('');
      expect(getNodeRunId(undefined)).toBe('');
    });

    it('splits on the last separator so a name may contain one', () => {
      expect(getNodeRunId({path: 'node@a@b'})).toBe('b');
    });
  });

  describe('getParentNodeRunId', () => {
    it('returns the run id of the second-to-last segment', () => {
      expect(getParentNodeRunId({path: 'wf@1.node@2'})).toBe('1');
      expect(getParentNodeRunId({path: 'a@1.b@2.c@3'})).toBe('2');
    });

    it('returns undefined when the parent carries no run id', () => {
      expect(getParentNodeRunId({path: 'wf.node@2'})).toBeUndefined();
    });

    it('returns undefined for a single segment', () => {
      expect(getParentNodeRunId({path: 'node@2'})).toBeUndefined();
    });

    it('returns undefined for an empty or absent path', () => {
      expect(getParentNodeRunId({path: ''})).toBeUndefined();
      expect(getParentNodeRunId(undefined)).toBeUndefined();
    });
  });

  describe('getNodePathName', () => {
    it('strips the run id from the leaf segment', () => {
      expect(getNodePathName({path: 'wf@1.node@2'})).toBe('node');
    });

    it('returns the leaf segment when it carries no run id', () => {
      expect(getNodePathName({path: 'wf.node'})).toBe('node');
    });

    it('returns an empty string for an empty or absent path', () => {
      expect(getNodePathName({path: ''})).toBe('');
      expect(getNodePathName(undefined)).toBe('');
    });
  });
});

describe('getNodeName', () => {
  it('returns the name of the emitting node', () => {
    expect(getNodeName(createEvent({nodePath: 'wf@1.review@3'}))).toBe(
      'review',
    );
  });

  it('returns an empty string for an agent state event', () => {
    const event = createEvent({
      nodePath: 'wf@1.review@3',
      actions: createEventActions({agentState: {foo: 1}}),
    });
    expect(getNodeName(event)).toBe('');
  });

  it('returns an empty string for an end-of-agent event', () => {
    const event = createEvent({
      nodePath: 'wf@1.review@3',
      actions: createEventActions({endOfAgent: true}),
    });
    expect(getNodeName(event)).toBe('');
  });

  it('returns the name when the agent state snapshot is empty', () => {
    const event = createEvent({
      nodePath: 'wf@1.review@3',
      actions: createEventActions({agentState: {}}),
    });
    expect(getNodeName(event)).toBe('review');
  });

  it('returns an empty string when the event has no node info', () => {
    expect(getNodeName(createEvent())).toBe('');
  });
});

describe('message alias', () => {
  it('converts a string message to user content', () => {
    const event = createEvent({message: 'Hello!'});
    expect(event.content!.parts![0].text).toBe('Hello!');
    expect(event.content!.role).toBe('user');
  });

  it('stores a Content message unchanged', () => {
    const content: Content = {role: 'model', parts: [{text: 'from Content'}]};
    expect(createEvent({message: content}).content).toBe(content);
  });

  it('converts a single part', () => {
    const event = createEvent({message: {text: 'from Part'}});
    expect(event.content!.parts![0].text).toBe('from Part');
  });

  it('converts a list of parts and keeps their order', () => {
    const event = createEvent({message: [{text: 'part1'}, {text: 'part2'}]});
    expect(event.content!.parts!.map((part) => part.text)).toEqual([
      'part1',
      'part2',
    ]);
  });

  it('rejects a message given together with content', () => {
    expect(() =>
      createEvent({message: 'hello', content: {parts: [{text: 'world'}]}}),
    ).toThrow(InputValidationError);
    expect(() =>
      createEvent({message: 'hello', content: {parts: [{text: 'world'}]}}),
    ).toThrow(/mutually exclusive/);
  });

  it('leaves content alone when no message is given', () => {
    const content: Content = {role: 'model', parts: [{text: 'via content'}]};
    expect(createEvent({content}).content).toBe(content);
    expect(createEvent().content).toBeUndefined();
  });

  it('reads the content back through getEventMessage', () => {
    const event = createEvent({message: 'Hello!'});
    expect(getEventMessage(event)).toBe(event.content);
    expect(getEventMessage(createEvent())).toBeUndefined();
  });

  it('sets the content through setEventMessage', () => {
    const event = createEvent();
    setEventMessage(event, 'updated');
    expect(event.content!.parts![0].text).toBe('updated');
    expect(event.content!.role).toBe('user');

    const content: Content = {role: 'model', parts: [{text: 'replaced'}]};
    setEventMessage(event, content);
    expect(event.content).toBe(content);
  });

  it('clears the content when set to undefined or null', () => {
    const event = createEvent({message: 'hello'});
    setEventMessage(event, undefined);
    expect(event.content).toBeUndefined();

    setEventMessage(event, 'hello again');
    setEventMessage(event, null);
    expect(event.content).toBeUndefined();
  });

  it('serializes as content, never as message', () => {
    const snake = transformToSnakeCaseEvent(createEvent({message: 'Hello!'}));
    expect(snake['content']).toBeDefined();
    expect('message' in snake).toBe(false);

    const restored = transformToCamelCaseEvent(snake);
    expect(restored.content!.parts![0].text).toBe('Hello!');
  });
});

describe('convenience construction kwargs', () => {
  it('routes state to the state delta', () => {
    expect(createEvent({state: {key: 'value'}}).actions.stateDelta).toEqual({
      key: 'value',
    });
    expect(createEvent().actions.stateDelta).toEqual({});
  });

  it('keeps the other actions when state is given', () => {
    const event = createEvent({
      state: {key: 'value'},
      actions: {skipSummarization: true},
    });
    expect(event.actions.stateDelta).toEqual({key: 'value'});
    expect(event.actions.skipSummarization).toBe(true);
  });

  it('routes nodePath to the node info path', () => {
    expect(createEvent({nodePath: 'root.node'}).nodeInfo!.path).toBe(
      'root.node',
    );
  });

  it('keeps the other node info fields when nodePath is given', () => {
    const event = createEvent({nodePath: 'x', nodeInfo: {outputFor: ['a']}});
    expect(event.nodeInfo!.path).toBe('x');
    expect(event.nodeInfo!.outputFor).toEqual(['a']);
  });

  it('accepts every convenience option at once', () => {
    const event = createEvent({
      message: 'hello',
      state: {key: 'value'},
      route: 'next',
      nodePath: 'a.b',
    });
    expect(event.content!.parts![0].text).toBe('hello');
    expect(event.actions.stateDelta).toEqual({key: 'value'});
    expect(event.route).toBe('next');
    expect(event.nodeInfo!.path).toBe('a.b');
  });

  it('does not mutate the params it is given', () => {
    const params = {
      message: 'Hello!',
      state: {key: 'value'},
      route: 'next',
      nodePath: 'root.node',
      nodeInfo: {outputFor: ['a']},
      actions: {skipSummarization: true},
    };
    const original = structuredClone(params);

    createEvent(params);

    expect(params).toEqual(original);
  });

  it('does not copy the convenience options onto the event', () => {
    const event = createEvent({
      message: 'hello',
      state: {key: 'value'},
      nodePath: 'a.b',
    });
    expect('message' in event).toBe(false);
    expect('state' in event).toBe(false);
    expect('nodePath' in event).toBe(false);
  });
});

describe('longRunningToolIds serialization', () => {
  const toolIds = ['call_1', 'call_2', 'call_3', 'call_4', 'zzz', 'mmm', 'kkk'];

  /** An event literal that never passed through `createEvent`. */
  function rehydratedEvent(longRunningToolIds: string[]): Event {
    return {
      id: 'stored-id',
      invocationId: 'inv-1',
      author: 'user',
      actions: createEventActions(),
      longRunningToolIds,
      timestamp: 1,
    };
  }

  it('sorts the ids of an event built by the factory', () => {
    const event = createEvent({author: 'user', longRunningToolIds: toolIds});
    expect(event.longRunningToolIds).toEqual([...toolIds].sort());
    expect(transformToSnakeCaseEvent(event)['long_running_tool_ids']).toEqual(
      [...toolIds].sort(),
    );
  });

  it('sorts the ids of an event that bypassed the factory', () => {
    const snake = transformToSnakeCaseEvent(
      rehydratedEvent(['zzz', 'aaa', 'mmm']),
    );
    expect(snake['long_running_tool_ids']).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('collapses duplicates', () => {
    expect(
      createEvent({longRunningToolIds: ['zzz', 'aaa', 'aaa']})
        .longRunningToolIds,
    ).toEqual(['aaa', 'zzz']);
    expect(
      transformToSnakeCaseEvent(rehydratedEvent(['zzz', 'aaa', 'aaa']))[
        'long_running_tool_ids'
      ],
    ).toEqual(['aaa', 'zzz']);
  });

  it('does not reorder the array of the event it serializes', () => {
    const ids = ['zzz', 'aaa'];
    transformToSnakeCaseEvent(rehydratedEvent(ids));
    expect(ids).toEqual(['zzz', 'aaa']);
  });

  it('leaves an unset value as the empty default and round-trips it', () => {
    const event = createEvent({author: 'user'});
    expect(event.longRunningToolIds).toEqual([]);

    const restored = transformToCamelCaseEvent(
      transformToSnakeCaseEvent(event),
    );
    expect(restored.longRunningToolIds).toEqual([]);
  });

  it('still marks an event with ids as the final response', () => {
    const event = createEvent({longRunningToolIds: ['zzz', 'aaa']});
    expect(isFinalResponse(event)).toBe(true);
  });
});
