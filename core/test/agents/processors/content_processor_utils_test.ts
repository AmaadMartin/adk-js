/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CompactedEvent, createEvent, Event} from '@google/adk';
import {Content, Outcome, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  getContents,
  getCurrentTurnContents,
  mergeFunctionResponseEvents,
  removeClientFunctionCallId,
} from '../../../src/agents/processors/content_processor_utils.js';
import {createCompactedEvent} from '../../../src/events/compacted_event.js';

describe('getContents', () => {
  it('should handle object responses in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionResponse: {
              name: 'transfer_to_agent',
              response: {
                result: 'success',
                details: {
                  foo: 'bar',
                },
              },
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    // We expect the content to contain a string representation of the object, not [object Object]
    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('transfer_to_agent'),
    );
    expect(textPart).toBeDefined();
    expect(textPart?.text).not.toContain('[object Object]');
    expect(textPart?.text).toContain('{"result":"success"');
  });

  it('should handle object parameters in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'transfer_to_agent',
              args: {
                target_agent: 'foo',
                reason: 'bar',
              },
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('transfer_to_agent'),
    );
    expect(textPart).toBeDefined();
    expect(textPart?.text).not.toContain('[object Object]');
    expect(textPart?.text).toContain('{"target_agent":"foo"');
  });

  it('should handle circular objects in convertForeignEvent', () => {
    const circular: Record<string, unknown> = {a: 1};
    circular.self = circular;

    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'circular_tool',
              args: circular,
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('circular_tool'),
    );
    expect(textPart).toBeDefined();
    // It should fall back to String(obj) which is usually [object Object] for plain objects.
    expect(textPart?.text).toContain('[object Object]');
  });

  it('should rearrange basic function call and response events correctly', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const e1 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'intermediate user message'}],
      },
    });
    const e3 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'success'},
            },
          },
        ],
      },
    });

    const contents = getContents([e0, e1, e2, e3], 'my_agent');

    // Expected output order: e0 (user input), e1 (function call), merged response (e3 response part)
    // Note that intermediate user input (e2) between call and response is discarded.
    expect(contents).toHaveLength(3);
    expect(contents[0].parts?.[0].text).toBe('hello');
    expect(contents[1].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[2].parts?.[0].functionResponse?.id).toBe('id1');
  });

  it('should avoid multiple mutations/overwrites and process multiple function calls safely', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const e1 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
          {
            functionCall: {
              name: 'tool2',
              id: 'id2',
              args: {},
            },
          },
        ],
      },
    });
    const e3 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success'},
            },
          },
        ],
      },
    });

    // We expect it to match the latest event e2 (which has id1 and id2) for the response id2,
    // and terminate the loop immediately. If it didn't terminate, it would continue back to e1,
    // matching id1 (due to mutated state), causing a subset error or wrong rearrangement index.
    const contents = getContents([e0, e1, e2, e3], 'my_agent');
    expect(contents).toHaveLength(4);
    expect(contents[0].parts?.[0].text).toBe('hello');
    expect(contents[1].parts?.[0].functionCall?.id).toBe('id1');
    // e2 has two function calls:
    expect(contents[2].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[2].parts?.[1].functionCall?.id).toBe('id2');
    // e3 is merged/rearranged after e2:
    expect(contents[3].parts?.[0].functionResponse?.id).toBe('id2');
  });

  it('should prune a trailing response whose function call is not in the history', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const e1 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            // response with id2, but the call event e1 only has id1
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success'},
            },
          },
        ],
      },
    });

    const contents = getContents([e0, e1, e2], 'my_agent');

    expect(contents).toHaveLength(2);
    expect(contents[0].parts?.[0].text).toBe('hello');
    expect(contents[1].parts?.[0].functionCall?.id).toBe('id1');
  });

  it('should prune the orphaned part of a response event and keep the paired one', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
        ],
      },
    });
    const e0_5 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'success'},
            },
          },
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success'},
            },
          },
        ],
      },
    });

    const contents = getContents([e0, e0_5, e1], 'my_agent');

    const responses = contents.flatMap(
      (content) =>
        content.parts?.flatMap((part) =>
          part.functionResponse ? [part.functionResponse] : [],
        ) ?? [],
    );
    expect(responses.map((response) => response.id)).toEqual(['id1']);
  });

  it('should still throw the subset error when responses span two call events', () => {
    const callOne = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'tool1', id: 'id1', args: {}}}],
      },
    });
    const callTwo = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'tool2', id: 'id2', args: {}}}],
      },
    });
    const filler = createEvent({
      author: 'user',
      content: {role: 'user', parts: [{text: 'hello'}]},
    });
    const responses = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool1', id: 'id1', response: {}}},
          {functionResponse: {name: 'tool2', id: 'id2', response: {}}},
        ],
      },
    });

    expect(() =>
      getContents([callOne, callTwo, filler, responses], 'my_agent'),
    ).toThrowError(
      'Last response event should only contain the responses for the function calls in the same function call event.',
    );
  });

  it('should handle empty events list gracefully', () => {
    const contents = getContents([], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should collect and merge intermediate response events for parallel function calls', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
          {
            functionCall: {
              name: 'tool2',
              id: 'id2',
              args: {},
            },
          },
        ],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'success1'},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success2'},
            },
          },
        ],
      },
    });

    const contents = getContents([e0, e1, e2], 'my_agent');
    expect(contents).toHaveLength(2);
    expect(contents[0].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[0].parts?.[1].functionCall?.id).toBe('id2');

    // e1 and e2 should be merged:
    expect(contents[1].parts?.[0].functionResponse?.id).toBe('id1');
    expect(contents[1].parts?.[0].functionResponse?.response).toEqual({
      result: 'success1',
    });
    expect(contents[1].parts?.[1].functionResponse?.id).toBe('id2');
    expect(contents[1].parts?.[1].functionResponse?.response).toEqual({
      result: 'success2',
    });
  });

  it('should not mutate input events content', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
          {
            functionCall: {
              name: 'tool2',
              id: 'id2',
              args: {},
            },
          },
        ],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'success1'},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success2'},
            },
          },
        ],
      },
    });

    const originalE1PartsLength = e1.content?.parts?.length;

    getContents([e0, e1, e2], 'my_agent');

    expect(e1.content?.parts?.length).toBe(originalE1PartsLength);
  });

  it('should convert CompactedEvent correctly', () => {
    const compactedEvent = {
      isCompacted: true,
      author: 'user',
      compactedContent: 'synthesized summary',
      timestamp: 12345,
      invocationId: 'inv1',
      branch: 'main',
    } as unknown as CompactedEvent;

    const contents = getContents([compactedEvent], 'my_agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts?.[0].text).toContain(
      '[Previous Context Summary]:\nsynthesized summary',
    );
  });

  it('should skip rearranging when the second latest event contains the corresponding function calls', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const e1 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'tool1',
              id: 'id1',
              args: {},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'success'},
            },
          },
        ],
      },
    });

    const contents = getContents([e0, e1, e2], 'my_agent');
    expect(contents).toHaveLength(3);
    expect(contents[0].parts?.[0].text).toBe('hello');
    expect(contents[1].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[2].parts?.[0].functionResponse?.id).toBe('id1');
  });

  it('should handle string arguments in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'transfer_to_agent',
              args: 'plain_string_args' as unknown as Record<string, unknown>,
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');
    const textPart = contents[0].parts?.find((p) =>
      p.text?.includes('transfer_to_agent'),
    );
    expect(textPart).toBeDefined();
    expect(textPart?.text).toContain('plain_string_args');
  });

  it('should handle plain text parts in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            text: 'hello from other agent',
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].parts).toHaveLength(2);
    expect(contents[0].parts?.[1].text).toBe(
      '[other_agent] said: hello from other agent',
    );
  });

  it('should replace function responses with the same id and append non-function-response parts during merge', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'tool1', id: 'id1', args: {}}},
          {functionCall: {name: 'tool2', id: 'id2', args: {}}},
        ],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'initial'},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'updated'},
            },
          },
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'success2'},
            },
          },
          {text: 'some extra message'},
        ],
      },
    });

    const contents = getContents([e0, e1, e2], 'my_agent');
    expect(contents).toHaveLength(2);
    const mergedResponseParts = contents[1].parts;
    expect(mergedResponseParts).toHaveLength(3);
    expect(mergedResponseParts?.[0].functionResponse?.response).toEqual({
      result: 'updated',
    });
    expect(mergedResponseParts?.[1].functionResponse?.response).toEqual({
      result: 'success2',
    });
    expect(mergedResponseParts?.[2].text).toBe('some extra message');
  });

  it('should merge multiple function responses in history when size > 1', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'tool1', id: 'id1', args: {}}},
          {functionCall: {name: 'tool2', id: 'id2', args: {}}},
        ],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              id: 'id1',
              response: {result: 'res1'},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool2',
              id: 'id2',
              response: {result: 'res2'},
            },
          },
        ],
      },
    });
    const e3 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });

    const contents = getContents([e0, e1, e2, e3], 'my_agent');
    expect(contents).toHaveLength(3);
    expect(contents[0].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[1].parts).toHaveLength(2);
    expect(contents[1].parts?.[0].functionResponse?.id).toBe('id1');
    expect(contents[1].parts?.[1].functionResponse?.id).toBe('id2');
    expect(contents[2].parts?.[0].text).toBe('hello');
  });

  it('should skip mapping function response event when response id is missing', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'tool1', id: 'id1', args: {}}}],
      },
    });
    const e1 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              response: {result: 'res1'},
            },
          },
        ],
      },
    });
    const e2 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });

    const contents = getContents([e0, e1, e2], 'my_agent');
    expect(contents).toHaveLength(2);
    expect(contents[0].parts?.[0].functionCall?.id).toBe('id1');
    expect(contents[1].parts?.[0].text).toBe('hello');
  });

  it('should handle empty agentName in getContents', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [{text: 'hello'}],
      },
    });
    const contents = getContents([event], '');
    expect(contents).toHaveLength(1);
    expect(contents[0].parts?.[0].text).toBe('hello');
  });

  describe('getCurrentTurnContents', () => {
    it('should return empty list when no events are provided', () => {
      const contents = getCurrentTurnContents([], 'my_agent');
      expect(contents).toEqual([]);
    });

    it('should slice events from the last user or foreign agent event', () => {
      const e0 = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      });
      const e1 = createEvent({
        author: 'my_agent',
        content: {role: 'model', parts: [{text: 'hi'}]},
      });
      const e2 = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'how are you?'}]},
      });
      const e3 = createEvent({
        author: 'my_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool1', id: 'id1', args: {}}}],
        },
      });

      const contents = getCurrentTurnContents([e0, e1, e2, e3], 'my_agent');
      expect(contents).toHaveLength(2);
      expect(contents[0].parts?.[0].text).toBe('how are you?');
      expect(contents[1].parts?.[0].functionCall?.id).toBe('id1');
    });

    it('should return empty list if no user or foreign agent starts a turn', () => {
      const e0 = createEvent({
        author: 'my_agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
      const contents = getCurrentTurnContents([e0], 'my_agent');
      expect(contents).toEqual([]);
    });

    it('should handle empty agentName in getCurrentTurnContents', () => {
      const e0 = createEvent({
        author: 'other_agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });
      const contents = getCurrentTurnContents([e0], '');
      expect(contents).toEqual([]);
    });
  });

  it('should handle media parts in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'base64data',
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].parts).toHaveLength(2); // 'For context:' part and the inlineData part
    expect(contents[0].parts?.[1]).toEqual({
      inlineData: {
        mimeType: 'image/png',
        data: 'base64data',
      },
    });
  });

  it('should not mutate original event media parts in convertForeignEvent', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'base64data',
            },
          },
        ],
      },
    });

    const contents = getContents([event], 'current_agent');

    // Mutate the returned content
    if (contents[0].parts?.[1]?.inlineData) {
      contents[0].parts[1].inlineData.data = 'mutated';
    }

    // Check if original event was mutated
    expect(event.content?.parts?.[0]?.inlineData?.data).toBe('base64data');
  });

  describe('mergeFunctionResponseEvents', () => {
    it('should throw an error when merging empty list of events', () => {
      expect(() => mergeFunctionResponseEvents([])).toThrowError(
        'Cannot merge an empty list of events.',
      );
    });

    it('should throw an error when first event has no parts', () => {
      const e0 = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [],
        },
      });
      expect(() => mergeFunctionResponseEvents([e0])).toThrowError(
        'There should be at least one function_response part.',
      );
    });

    it('should throw an error when first event has no content', () => {
      const e0 = createEvent({
        author: 'user',
      });
      expect(() => mergeFunctionResponseEvents([e0])).toThrowError(
        'There should be at least one function_response part.',
      );
    });

    it('should throw an error when subsequent event has no content or parts', () => {
      const e0 = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool1',
                id: 'id1',
                response: {result: 'success'},
              },
            },
          ],
        },
      });
      const e1 = createEvent({
        author: 'user',
      });
      expect(() => mergeFunctionResponseEvents([e0, e1])).toThrowError(
        'There should be at least one function_response part.',
      );
    });

    it('should not mutate subsequent events when merging', () => {
      const e0 = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool1',
                id: 'id1',
                response: {result: 'initial'},
              },
            },
          ],
        },
      });
      const e1 = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool2',
                id: 'id2',
                response: {result: 'success2'},
              },
            },
          ],
        },
      });

      const merged = mergeFunctionResponseEvents([e0, e1]);

      // Mutate the merged event parts
      if (merged.content?.parts?.[0]?.functionResponse) {
        merged.content.parts[0].functionResponse.response = {
          result: 'mutated0',
        };
      }
      if (merged.content?.parts?.[1]?.functionResponse) {
        merged.content.parts[1].functionResponse.response = {
          result: 'mutated1',
        };
      }

      // Check if e0 was mutated
      expect(e0.content?.parts?.[0]?.functionResponse?.response).toEqual({
        result: 'initial',
      });

      // Check if e1 was mutated
      expect(e1.content?.parts?.[0]?.functionResponse?.response).toEqual({
        result: 'success2',
      });
    });
  });

  it('should skip tool confirmation events in getContents', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'adk_request_confirmation',
              args: {},
            },
          },
        ],
      },
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should skip auth events in getContents', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'adk_request_credential',
              args: {},
            },
          },
        ],
      },
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should skip a user event that carries no parts', () => {
    const event = createEvent({
      author: 'my_agent',
      content: {
        role: 'user',
      },
    });
    const contents = getContents([event], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should skip a foreign event whose parts list is empty', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [],
      },
    });
    const contents = getContents([event], 'current_agent');
    expect(contents).toEqual([]);
  });

  it('should skip a model event that carries no parts', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
      },
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should skip events with no role in getContents', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        parts: [{text: 'hello'}],
      } as unknown as Content,
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should skip events with empty first part text in getContents', () => {
    const e0 = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{text: ''}],
      },
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toEqual([]);
  });

  it('should skip events from non-matching branch in getContents', () => {
    const e0 = createEvent({
      author: 'user',
      branch: 'main.agentB',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const contents = getContents([e0], 'my_agent', 'main.agentA');
    expect(contents).toEqual([]);
  });

  it('should not skip events from matching branch in getContents', () => {
    const e0 = createEvent({
      author: 'user',
      branch: 'main.agentA',
      content: {
        role: 'user',
        parts: [{text: 'hello'}],
      },
    });
    const contents = getContents([e0], 'my_agent', 'main.agentA.subAgent');
    expect(contents).toHaveLength(1);
    expect(contents[0].parts?.[0].text).toBe('hello');
  });

  it('should reject substring false positives in getContents (e.g. agent_1.agent vs agent_1.agent_2)', () => {
    const e0 = createEvent({
      author: 'user',
      branch: 'agent_1.agent',
      content: {
        role: 'user',
        parts: [{text: 'event from agent_1.agent'}],
      },
    });
    const e1 = createEvent({
      author: 'user',
      branch: 'agent_1.agent_2',
      content: {
        role: 'user',
        parts: [{text: 'event from agent_1.agent_2'}],
      },
    });

    const contentsForAgent2 = getContents(
      [e0, e1],
      'my_agent',
      'agent_1.agent_2',
    );
    expect(contentsForAgent2).toHaveLength(1);
    expect(contentsForAgent2[0].parts?.[0].text).toBe(
      'event from agent_1.agent_2',
    );

    const contentsForAgent = getContents([e0, e1], 'my_agent', 'agent_1.agent');
    expect(contentsForAgent).toHaveLength(1);
    expect(contentsForAgent[0].parts?.[0].text).toBe(
      'event from agent_1.agent',
    );
  });

  it('should handle complex multi-agent tree execution branch hierarchy seamlessly in getContents', () => {
    const eRoot = createEvent({
      author: 'user',
      branch: 'coordinator',
      content: {role: 'user', parts: [{text: 'start task'}]},
    });
    const eResearcher = createEvent({
      author: 'researcher',
      branch: 'coordinator.researcher',
      content: {role: 'model', parts: [{text: 'research data'}]},
    });
    const eScraper = createEvent({
      author: 'scraper',
      branch: 'coordinator.researcher.scraper',
      content: {role: 'model', parts: [{text: 'scraped output'}]},
    });
    const eWriter = createEvent({
      author: 'writer',
      branch: 'coordinator.writer',
      content: {role: 'model', parts: [{text: 'written draft'}]},
    });

    const scraperContents = getContents(
      [eRoot, eResearcher, eScraper, eWriter],
      'scraper',
      'coordinator.researcher.scraper',
    );

    expect(scraperContents).toHaveLength(3);
    expect(scraperContents[0].parts?.[0].text).toBe('start task');
    expect(scraperContents[1].parts?.[0].text).toBe('For context:');
    expect(scraperContents[1].parts?.[1].text).toContain('research data');
    expect(scraperContents[2].parts?.[0].text).toBe('scraped output');
  });
});

describe('removeClientFunctionCallId', () => {
  it('should remove client generated ID from functionCall', () => {
    const content: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'testTool', args: {}, id: 'adk-test-id'}}],
    };
    removeClientFunctionCallId(content);
    expect(content.parts![0].functionCall!.id).toBeUndefined();
  });

  it('should remove client generated ID from functionResponse', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {functionResponse: {name: 'testTool', response: {}, id: 'adk-test-id'}},
      ],
    };
    removeClientFunctionCallId(content);
    expect(content.parts![0].functionResponse!.id).toBeUndefined();
  });

  it('should not remove non-client generated ID', () => {
    const content: Content = {
      role: 'model',
      parts: [{functionCall: {name: 'testTool', args: {}, id: 'server-id'}}],
    };
    removeClientFunctionCallId(content);
    expect(content.parts![0].functionCall!.id).toBe('server-id');
  });

  it('should safely handle null, undefined, or empty content objects without throwing', () => {
    expect(() =>
      removeClientFunctionCallId(undefined as unknown as Content),
    ).not.toThrow();
    expect(() =>
      removeClientFunctionCallId(null as unknown as Content),
    ).not.toThrow();
    const emptyContent: Content = {};
    expect(() => removeClientFunctionCallId(emptyContent)).not.toThrow();
    const noParts: Content = {role: 'user', parts: []};
    expect(() => removeClientFunctionCallId(noParts)).not.toThrow();
  });
});

describe('getContents — adk-python parity', () => {
  function userTurn(text: string, invocationId = 'inv-1'): Event {
    return createEvent({
      author: 'user',
      invocationId,
      content: {role: 'user', parts: [{text}]},
    });
  }

  function textsOf(contents: Content[]): string[] {
    return contents.flatMap((content) =>
      (content.parts ?? []).map((part) => part.text ?? ''),
    );
  }

  describe('function call ids', () => {
    const callEvent = () =>
      createEvent({
        author: 'my_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool', id: 'adk-1', args: {}}}],
        },
      });
    const responseEvent = () =>
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {name: 'tool', id: 'adk-1', response: {}}},
          ],
        },
      });

    it('strips the adk- ids by default', () => {
      const contents = getContents([callEvent(), responseEvent()], 'my_agent');

      expect(contents[0].parts?.[0].functionCall?.id).toBeUndefined();
      expect(contents[1].parts?.[0].functionResponse?.id).toBeUndefined();
    });

    it('preserves the adk- ids for a provider that pairs by id', () => {
      const contents = getContents(
        [callEvent(), responseEvent()],
        'my_agent',
        undefined,
        undefined,
        {preserveFunctionCallIds: true},
      );

      expect(contents[0].parts?.[0].functionCall?.id).toBe('adk-1');
      expect(contents[1].parts?.[0].functionResponse?.id).toBe('adk-1');
    });

    it('leaves the session events untouched when stripping the ids', () => {
      const call = callEvent();

      getContents([call], 'my_agent');

      expect(call.content?.parts?.[0].functionCall?.id).toBe('adk-1');
    });
  });

  describe('visible parts', () => {
    function contentsForParts(parts: Part[]): Content[] {
      const event = createEvent({
        author: 'my_agent',
        content: {role: 'model', parts},
      });
      return getContents([event], 'my_agent');
    }

    it('keeps a part that carries only a thought signature', () => {
      const contents = contentsForParts([{thoughtSignature: 'opaque'}]);

      expect(contents).toHaveLength(1);
      expect(contents[0].parts?.[0].thoughtSignature).toBe('opaque');
    });

    it('keeps a server-side tool call', () => {
      const contents = contentsForParts([
        {toolCall: {id: 'search-1', args: {q: 'ravens'}}},
      ]);

      expect(contents[0].parts?.[0].toolCall?.id).toBe('search-1');
    });

    it('keeps a server-side tool response', () => {
      const contents = contentsForParts([
        {toolResponse: {id: 'search-1', response: {hits: 2}}},
      ]);

      expect(contents[0].parts?.[0].toolResponse?.id).toBe('search-1');
    });

    it('keeps a server-side tool call marked as a thought', () => {
      const contents = contentsForParts([
        {toolCall: {id: 'search-1'}, thought: true},
      ]);

      expect(contents[0].parts?.[0].toolCall?.id).toBe('search-1');
    });

    it('keeps a function call marked as a thought', () => {
      const contents = contentsForParts([
        {functionCall: {name: 'tool', id: 'c1', args: {}}, thought: true},
      ]);

      expect(contents[0].parts?.[0].functionCall?.id).toBe('c1');
    });

    it('keeps a function response marked as a thought', () => {
      const call = createEvent({
        author: 'my_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool', id: 'c1', args: {}}}],
        },
      });
      const response = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {name: 'tool', id: 'c1', response: {}},
              thought: true,
            },
          ],
        },
      });

      const contents = getContents([call, response], 'my_agent');

      expect(contents[1].parts?.[0].functionResponse?.id).toBe('c1');
    });

    it('keeps a code execution result that is not the first part', () => {
      const contents = contentsForParts([
        {text: ''},
        {codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: '42'}},
      ]);

      expect(contents).toHaveLength(1);
      expect(contents[0].parts?.[1].codeExecutionResult?.output).toBe('42');
    });

    it('skips an event whose parts are all thoughts', () => {
      const event = createEvent({
        author: 'other_agent',
        content: {role: 'model', parts: [{text: 'reasoning', thought: true}]},
      });

      expect(getContents([event], 'my_agent')).toEqual([]);
    });

    it('keeps another agent thought-only event when thoughts are included', () => {
      const event = createEvent({
        author: 'other_agent',
        content: {role: 'model', parts: [{text: 'reasoning', thought: true}]},
      });

      const contents = getContents([event], 'my_agent', undefined, undefined, {
        includeThoughtsFromOtherAgents: true,
      });

      expect(textsOf(contents)).toEqual([
        'For context:',
        '[other_agent] thought: reasoning',
      ]);
    });
  });

  describe('transcriptions', () => {
    function inputTranscript(text?: string): Event {
      return createEvent({
        author: 'user',
        invocationId: 'inv-1',
        inputTranscription: text === undefined ? {finished: true} : {text},
      });
    }

    function outputTranscript(text: string): Event {
      return createEvent({
        author: 'my_agent',
        invocationId: 'inv-1',
        outputTranscription: {text},
      });
    }

    it('turns one input transcription into a user content', () => {
      const contents = getContents(
        [inputTranscript('hello there')],
        'my_agent',
      );

      expect(contents).toEqual([
        {role: 'user', parts: [{text: 'hello there'}]},
      ]);
    });

    it('joins a run of input transcriptions into one user content', () => {
      const contents = getContents(
        [
          inputTranscript('hello '),
          inputTranscript('there '),
          inputTranscript('friend'),
        ],
        'my_agent',
      );

      expect(contents).toEqual([
        {role: 'user', parts: [{text: 'hello there friend'}]},
      ]);
    });

    it('turns a run of output transcriptions into one model content', () => {
      const contents = getContents(
        [outputTranscript('good '), outputTranscript('morning')],
        'my_agent',
      );

      expect(contents).toEqual([
        {role: 'model', parts: [{text: 'good morning'}]},
      ]);
    });

    it('keeps the input and output accumulators independent', () => {
      const contents = getContents(
        [
          inputTranscript('what '),
          inputTranscript('time is it'),
          outputTranscript('it is '),
          outputTranscript('noon'),
        ],
        'my_agent',
      );

      expect(contents).toEqual([
        {role: 'user', parts: [{text: 'what time is it'}]},
        {role: 'model', parts: [{text: 'it is noon'}]},
      ]);
    });

    it('starts a fresh accumulator after a run ends', () => {
      const contents = getContents(
        [inputTranscript('one'), userTurn('typed'), inputTranscript('two')],
        'my_agent',
      );

      expect(textsOf(contents)).toEqual(['one', 'typed', 'two']);
    });

    it('leaves a foreign transcription with no text out of the contents', () => {
      const foreign = createEvent({
        author: 'other_agent',
        invocationId: 'inv-1',
        outputTranscription: {finished: true},
      });

      expect(getContents([foreign], 'my_agent')).toEqual([]);
    });

    it('leaves the session event untouched', () => {
      const event = inputTranscript('hello');

      getContents([event], 'my_agent');

      expect(event.content).toBeUndefined();
      expect(event.inputTranscription?.text).toBe('hello');
    });

    it('contributes nothing for a transcription that carries no text', () => {
      const contents = getContents(
        [inputTranscript(), userTurn('typed instead')],
        'my_agent',
      );

      expect(textsOf(contents)).toEqual(['typed instead']);
    });
  });

  describe('another agent’s thoughts', () => {
    const event = () =>
      createEvent({
        author: 'other_agent',
        content: {
          role: 'model',
          parts: [
            {text: 'weighing options', thought: true},
            {text: 'the answer is 42'},
          ],
        },
      });

    it('omits the thought parts by default', () => {
      expect(textsOf(getContents([event()], 'my_agent'))).toEqual([
        'For context:',
        '[other_agent] said: the answer is 42',
      ]);
    });

    it('labels the thought parts when they are included', () => {
      const contents = getContents(
        [event()],
        'my_agent',
        undefined,
        undefined,
        {
          includeThoughtsFromOtherAgents: true,
        },
      );

      expect(textsOf(contents)).toEqual([
        'For context:',
        '[other_agent] thought: weighing options',
        '[other_agent] said: the answer is 42',
      ]);
    });

    it('omits a blank thought part even when thoughts are included', () => {
      const blank = createEvent({
        author: 'other_agent',
        content: {
          role: 'model',
          parts: [{text: '   ', thought: true}, {text: 'done'}],
        },
      });

      const contents = getContents([blank], 'my_agent', undefined, undefined, {
        includeThoughtsFromOtherAgents: true,
      });

      expect(textsOf(contents)).toEqual([
        'For context:',
        '[other_agent] said: done',
      ]);
    });
  });

  describe('the synthetic first turn of a scoped agent', () => {
    function delegatingCall(args: Record<string, unknown>): Event {
      return createEvent({
        author: 'coordinator',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'task', id: 'scope-1', args}}],
        },
      });
    }

    const scopedTurn = () =>
      createEvent({
        author: 'user',
        isolationScope: 'scope-1',
        content: {role: 'user', parts: [{text: 'working on it'}]},
      });

    it('states the delegating call arguments', () => {
      const contents = getContents(
        [delegatingCall({topic: 'ravens'}), scopedTurn()],
        'worker',
        undefined,
        'scope-1',
      );

      expect(textsOf(contents)).toEqual([
        '{"topic":"ravens"}',
        'working on it',
      ]);
    });

    it('leaves non-ASCII arguments unescaped', () => {
      const contents = getContents(
        [delegatingCall({topic: 'κόρακες'}), scopedTurn()],
        'worker',
        undefined,
        'scope-1',
      );

      expect(contents[0].parts?.[0].text).toBe('{"topic":"κόρακες"}');
    });

    it('appends the nudge only for a single-turn agent', () => {
      const events = [delegatingCall({topic: 'ravens'}), scopedTurn()];

      const plain = getContents(events, 'worker', undefined, 'scope-1');
      const singleTurn = getContents(events, 'worker', undefined, 'scope-1', {
        isSingleTurn: true,
      });

      expect(plain[0].parts).toHaveLength(1);
      expect(singleTurn[0].parts?.[1].text).toContain(
        'You will not receive any user replies',
      );
    });

    it('falls back to userContent when no call matches the scope', () => {
      const userContent: Content = {
        role: 'user',
        parts: [{text: 'summarize the report'}],
      };

      const contents = getContents(
        [scopedTurn()],
        'worker',
        undefined,
        'scope-1',
        {userContent},
      );

      expect(textsOf(contents)).toEqual([
        'summarize the report',
        'working on it',
      ]);
      expect(contents[0].parts?.[0]).not.toBe(userContent.parts?.[0]);
    });

    it('appends the nudge to the userContent fallback', () => {
      const contents = getContents(
        [scopedTurn()],
        'worker',
        undefined,
        'scope-1',
        {
          userContent: {role: 'user', parts: [{text: 'summarize the report'}]},
          isSingleTurn: true,
        },
      );

      expect(contents[0].parts?.[1].text).toContain(
        'Complete the task using only the information provided above.',
      );
    });

    it('ignores a delegating call that carries no arguments', () => {
      const contents = getContents(
        [delegatingCall({}), scopedTurn()],
        'worker',
        undefined,
        'scope-1',
      );

      expect(textsOf(contents)).toEqual(['working on it']);
    });

    it('prepends nothing when the agent has no isolation scope', () => {
      const contents = getContents(
        [userTurn('hello')],
        'worker',
        undefined,
        undefined,
        {
          userContent: {role: 'user', parts: [{text: 'node input'}]},
        },
      );

      expect(textsOf(contents)).toEqual(['hello']);
    });

    it('prepends nothing when neither source yields content', () => {
      const contents = getContents(
        [scopedTurn()],
        'worker',
        undefined,
        'scope-1',
      );

      expect(textsOf(contents)).toEqual(['working on it']);
    });
  });

  describe('orphaned function responses', () => {
    const call = (id: string) =>
      createEvent({
        author: 'my_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool', id, args: {}}}],
        },
      });

    it('prunes the orphaned part of a mid-history response event', () => {
      const response = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {name: 'tool', id: 'c1', response: {}}},
            {functionResponse: {name: 'gone', id: 'c9', response: {}}},
          ],
        },
      });

      const contents = getContents(
        [call('c1'), response, userTurn('thanks')],
        'my_agent',
      );

      const responseParts = contents[1].parts ?? [];
      expect(responseParts).toHaveLength(1);
      expect(responseParts[0].functionResponse?.name).toBe('tool');
    });

    it('drops a trailing event whose parts are all orphans', () => {
      const orphan = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [{functionResponse: {name: 'gone', id: 'c9', response: {}}}],
        },
      });

      const contents = getContents([call('c1'), orphan], 'my_agent');

      expect(contents).toHaveLength(1);
      expect(contents[0].parts?.[0].functionCall?.id).toBe('c1');
    });

    it('leaves a response that carries no id alone', () => {
      const response = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {name: 'tool', id: 'c1', response: {}}},
            {functionResponse: {name: 'legacy', response: {}}},
          ],
        },
      });

      const contents = getContents([call('c1'), response], 'my_agent');

      expect(contents[1].parts).toHaveLength(2);
      expect(contents[1].parts?.[1].functionResponse?.name).toBe('legacy');
    });

    it('leaves the session event untouched when pruning a part', () => {
      const response = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {name: 'tool', id: 'c1', response: {}}},
            {functionResponse: {name: 'gone', id: 'c9', response: {}}},
          ],
        },
      });

      getContents([call('c1'), response, userTurn('thanks')], 'my_agent');

      expect(response.content?.parts).toHaveLength(2);
    });
  });

  describe('the current-turn scan', () => {
    it('can start the turn on a compacted summary', () => {
      const compacted = createCompactedEvent({
        author: 'summarizer',
        compactedContent: 'earlier turns',
        startTime: 1,
        endTime: 1,
        timestamp: 1,
        invocationId: 'inv-1',
      });

      const reply = createEvent({
        author: 'my_agent',
        content: {role: 'model', parts: [{text: 'working on it'}]},
      });

      const contents = getCurrentTurnContents(
        [userTurn('long ago'), compacted, reply],
        'my_agent',
      );

      expect(textsOf(contents)).toEqual([
        '[Previous Context Summary]:\nearlier turns',
        'working on it',
      ]);
    });
  });

  describe('malformed histories', () => {
    it('still refuses an event that answers its own function call', () => {
      const selfAnswering = createEvent({
        author: 'my_agent',
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'tool', id: 'c1', args: {}}},
            {functionResponse: {name: 'tool', id: 'c1', response: {}}},
          ],
        },
      });

      expect(() => getContents([selfAnswering], 'my_agent')).toThrowError(
        'No function call event found for function responses ids: c1',
      );
    });
  });
});
