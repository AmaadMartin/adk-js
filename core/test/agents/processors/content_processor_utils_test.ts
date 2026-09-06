/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CompactedEvent, createEvent, Event} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  getContents,
  getCurrentTurnContents,
  mergeFunctionResponseEvents,
  removeClientFunctionCallId,
} from '../../../src/agents/processors/content_processor_utils.js';

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

  it('should throw an error when last responses do not match the expected subset criteria of function calls', () => {
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

    expect(() => getContents([e0, e1, e2], 'my_agent')).toThrowError(
      'No function call event found for function responses ids: id2',
    );
  });

  it('should throw subset error when response is for an id from a call event, but contains other unexpected ids', () => {
    // Actually, the subset error occurs when functionResponsesIds is NOT a subset of functionCallIds.
    // e.g. the last event has responses for id1 and id2, but the matched call event only has id1.
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

    expect(() => getContents([e0, e0_5, e1], 'my_agent')).toThrowError(
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

  it('should handle events with no parts in isAuthEvent and isToolConfirmationEvent', () => {
    const event = createEvent({
      author: 'my_agent',
      content: {
        role: 'user',
      },
    });
    const contents = getContents([event], 'my_agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
  });

  it('should return input event in convertForeignEvent if content or parts length is 0', () => {
    const event = createEvent({
      author: 'other_agent',
      content: {
        role: 'model',
        parts: [],
      },
    });
    const contents = getContents([event], 'current_agent');
    expect(contents).toHaveLength(1);
  });

  it('should handle event without parts in isToolConfirmationEvent', () => {
    const e0 = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
      },
    });
    const contents = getContents([e0], 'my_agent');
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('model');
    expect(contents[0].parts).toBeUndefined();
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

describe('function responses answering another agent', () => {
  const callByOtherAgent = createEvent({
    author: 'other_agent',
    content: {
      role: 'model',
      parts: [{functionCall: {name: 'search', id: 'call_1', args: {q: 'x'}}}],
    },
  });

  it('relays a user-authored response to another agent call as context', () => {
    const response = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'search',
              id: 'call_1',
              response: {result: 'found'},
            },
          },
        ],
      },
    });

    const contents = getContents([callByOtherAgent, response], 'my_agent');

    expect(contents).toHaveLength(2);
    expect(contents[1].role).toBe('user');
    expect(contents[1].parts?.[0]?.text).toBe('For context:');
    expect(contents[1].parts?.[1]?.text).toContain(
      '[user] tool `search` returned result:',
    );
    expect(contents[1].parts?.[1]?.text).toContain('{"result":"found"}');
  });

  it('leaves a response to the current agent own call alone', () => {
    const call = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'search', id: 'call_1', args: {}}}],
      },
    });
    const response = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'search',
              id: 'call_1',
              response: {result: 'found'},
            },
          },
        ],
      },
    });

    const contents = getContents([call, response], 'my_agent');

    expect(contents).toHaveLength(2);
    expect(contents[1].parts?.[0]?.functionResponse?.id).toBe('call_1');
  });

  it('leaves a response to a user call alone', () => {
    const call = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [{functionCall: {name: 'search', id: 'call_1', args: {}}}],
      },
    });
    const response = createEvent({
      author: 'my_agent',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'search',
              id: 'call_1',
              response: {result: 'found'},
            },
          },
        ],
      },
    });

    const contents = getContents([call, response], 'my_agent');

    expect(contents).toHaveLength(2);
    expect(contents[1].parts?.[0]?.functionResponse?.id).toBe('call_1');
  });

  it('leaves a response alone when no call in the window carries its id', () => {
    const response = createEvent({
      author: 'my_agent',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'search',
              id: 'unknown_call',
              response: {result: 'found'},
            },
          },
        ],
      },
    });

    const later = createEvent({
      author: 'user',
      content: {role: 'user', parts: [{text: 'anything else?'}]},
    });

    const contents = getContents(
      [callByOtherAgent, response, later],
      'my_agent',
    );

    const texts = contents.flatMap((content) =>
      (content.parts ?? []).map((part) => part.text ?? ''),
    );
    expect(texts.some((text) => text.includes('[my_agent]'))).toBe(false);
    expect(texts).toContain('anything else?');
  });
});

describe('adk_framework events', () => {
  const userEvent = createEvent({
    author: 'user',
    content: {role: 'user', parts: [{text: 'hello'}]},
  });

  it('drops an event carrying an adk_framework function call', () => {
    const frameworkCall = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'adk_framework', id: 'fw_1', args: {}}}],
      },
    });

    const contents = getContents([userEvent, frameworkCall], 'my_agent');

    expect(contents).toHaveLength(1);
    expect(contents[0].parts?.[0]?.text).toBe('hello');
  });

  it('drops an event carrying an adk_framework function response', () => {
    const frameworkResponse = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'adk_framework',
              id: 'fw_1',
              response: {done: true},
            },
          },
        ],
      },
    });

    const contents = getContents([userEvent, frameworkResponse], 'my_agent');

    expect(contents).toHaveLength(1);
    expect(contents[0].parts?.[0]?.text).toBe('hello');
  });

  it('keeps an event whose call is merely named like a tool', () => {
    const toolCall = createEvent({
      author: 'my_agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'adk_framework_tool', id: 'call_1', args: {}}},
        ],
      },
    });

    const contents = getContents([userEvent, toolCall], 'my_agent');

    expect(contents).toHaveLength(2);
    expect(contents[1].parts?.[0]?.functionCall?.name).toBe(
      'adk_framework_tool',
    );
  });
});

describe('getCurrentTurnContents anchor exclusions', () => {
  it('keeps the turn across a long-running tool resume', () => {
    const events = [
      createEvent({
        invocationId: 'inv1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'approve the request'}]},
      }),
      createEvent({
        invocationId: 'inv1',
        author: 'test_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'ask_for_approval',
                id: 'call_1',
                args: {ticket: 't1'},
              },
            },
          ],
        },
      }),
      createEvent({
        invocationId: 'inv1',
        author: 'test_agent',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'ask_for_approval',
                id: 'call_1',
                response: {status: 'pending'},
              },
            },
          ],
        },
      }),
      createEvent({
        invocationId: 'inv2',
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'ask_for_approval',
                id: 'call_1',
                response: {status: 'approved'},
              },
            },
          ],
        },
      }),
    ];

    const contents = getCurrentTurnContents(events, 'test_agent');

    expect(contents).toEqual([
      {role: 'user', parts: [{text: 'approve the request'}]},
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'ask_for_approval',
              id: 'call_1',
              args: {ticket: 't1'},
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'ask_for_approval',
              id: 'call_1',
              response: {status: 'approved'},
            },
          },
        ],
      },
    ]);
  });

  it('resumes past an interleaved user turn', () => {
    const events = [
      createEvent({
        invocationId: 'inv1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'approve the request'}]},
      }),
      createEvent({
        invocationId: 'inv1',
        author: 'test_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'ask_for_approval',
                id: 'call_1',
                args: {ticket: 't1'},
              },
            },
          ],
        },
      }),
      createEvent({
        invocationId: 'inv2',
        author: 'user',
        content: {
          role: 'user',
          parts: [{text: 'meanwhile, what is the weather?'}],
        },
      }),
      createEvent({
        invocationId: 'inv2',
        author: 'test_agent',
        content: {role: 'model', parts: [{text: 'sunny'}]},
      }),
      createEvent({
        invocationId: 'inv3',
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'ask_for_approval',
                id: 'call_1',
                response: {status: 'approved'},
              },
            },
          ],
        },
      }),
    ];

    const contents = getCurrentTurnContents(events, 'test_agent');

    const functionCalls = contents.flatMap((content) =>
      (content.parts ?? [])
        .map((part) => part.functionCall)
        .filter((call) => !!call),
    );
    const functionResponses = contents.flatMap((content) =>
      (content.parts ?? [])
        .map((part) => part.functionResponse)
        .filter((response) => !!response),
    );
    expect(functionCalls.map((call) => call.id)).toEqual(['call_1']);
    expect(functionResponses.map((response) => response.response)).toEqual([
      {status: 'approved'},
    ]);
    // The turn still anchors on the user input that started it, not on the
    // interleaved turn and not on the posted-back result.
    expect(contents[0]).toEqual({
      role: 'user',
      parts: [{text: 'approve the request'}],
    });
  });

  it('keeps the user input across a transfer_to_agent handoff', () => {
    const events = [
      createEvent({
        invocationId: 'inv1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'First user message'}]},
      }),
      createEvent({
        invocationId: 'inv1',
        author: 'parent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'transfer_to_agent',
                id: 'call_inv1',
                args: {agent_name: 'test_agent'},
              },
            },
          ],
        },
      }),
      createEvent({
        invocationId: 'inv1',
        author: 'parent',
        actions: {transferToAgent: 'test_agent'},
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'transfer_to_agent',
                id: 'call_inv1',
                response: {result: null},
              },
            },
          ],
        },
      }),
    ];

    const contents = getCurrentTurnContents(events, 'test_agent');

    expect(contents).toHaveLength(3);
    expect(contents[0].parts?.[0]?.text).toBe('First user message');
    expect(contents[1].parts?.[1]?.text).toContain(
      '[parent] called tool `transfer_to_agent`',
    );
    expect(contents[2].parts?.[1]?.text).toContain(
      '[parent] tool `transfer_to_agent` returned result:',
    );
  });

  it('does not anchor on a transfer marked only by the event actions', () => {
    const events = [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'First user message'}]},
      }),
      createEvent({
        author: 'parent',
        actions: {transferToAgent: 'test_agent'},
        content: {role: 'model', parts: [{text: 'handing over'}]},
      }),
    ];

    const contents = getCurrentTurnContents(events, 'test_agent');

    expect(contents).toHaveLength(2);
    expect(contents[0].parts?.[0]?.text).toBe('First user message');
  });

  it('anchors on an event whose content has no parts', () => {
    const events = [createEvent({author: 'user', content: {role: 'user'}})];

    const contents = getCurrentTurnContents(events, 'my_agent');

    expect(contents).toEqual([{role: 'user'}]);
  });

  it('anchors on an event that has no actions', () => {
    // A store that round-trips events through JSON drops an undefined field,
    // so a rehydrated event can reach the anchor scan without `actions`.
    const rehydrated: Event = JSON.parse(
      JSON.stringify({
        ...createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'hello'}]},
        }),
        actions: undefined,
      }),
    );

    const contents = getCurrentTurnContents([rehydrated], 'my_agent');

    expect(contents).toHaveLength(1);
    expect(contents[0].parts?.[0]?.text).toBe('hello');
  });
});
