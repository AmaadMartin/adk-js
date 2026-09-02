/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InteractionStatus} from '@google/adk';
import {
  GroundingMetadata,
  LiveServerGoAway,
  MediaModality,
  ServiceTier,
  TrafficType,
  TurnCompleteReason,
  UsageMetadata,
  VoiceActivity,
  VoiceActivityType,
} from '@google/genai';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  LiveResponseAggregator,
  type LiveServerContentWithStatus,
} from '../../src/utils/live_connection_utils.js';
import {logger} from '../../src/utils/logger.js';
import {liveServerMessage} from './live_server_message_test_utils.js';

describe('LiveResponseAggregator', () => {
  let warnSpy: MockInstance<typeof logger.warn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('should yield usage metadata', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const usageMetadata = {
      promptTokenCount: 10,
      responseTokenCount: 20,
      totalTokenCount: 30,
    };

    const generator = aggregator.processMessage(
      liveServerMessage({usageMetadata}),
    );
    const results = Array.from(generator);

    expect(results).toEqual([
      {
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
        },
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should stream text and yield full response on turnComplete', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    // Message 1: partial text
    const gen1 = aggregator.processMessage(
      liveServerMessage({
        serverContent: {
          modelTurn: {
            parts: [{text: 'Hello'}],
          },
        },
      }),
    );
    const res1 = Array.from(gen1);
    expect(res1).toEqual([
      {
        content: {parts: [{text: 'Hello'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      },
    ]);

    // Message 2: partial text and turnComplete
    const gen2 = aggregator.processMessage(
      liveServerMessage({
        serverContent: {
          modelTurn: {
            parts: [{text: ' world!'}],
          },
          turnComplete: true,
          interrupted: false,
          groundingMetadata: {groundingChunks: []} as GroundingMetadata,
        },
      }),
    );
    const res2 = Array.from(gen2);
    expect(res2).toEqual([
      {
        content: {parts: [{text: ' world!'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
        interrupted: false,
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'Hello world!'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
        groundingMetadata: {groundingChunks: []},
      },
      {
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
        interrupted: false,
        groundingMetadata: {groundingChunks: []},
      },
    ]);
  });

  it('should flush text when transitioning between thought and non-thought', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    // Message 1: thought
    const res1 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: 'Thinking...', thought: true}],
            },
          },
        }),
      ),
    );
    expect(res1).toEqual([
      {
        content: {parts: [{text: 'Thinking...', thought: true}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      },
    ]);

    // Message 2: transition to text
    const res2 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: 'Answer is 42.'}],
            },
          },
        }),
      ),
    );
    expect(res2).toEqual([
      {
        content: {
          role: 'model',
          parts: [{text: 'Thinking...', thought: true}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        content: {parts: [{text: 'Answer is 42.'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      },
    ]);

    // Message 3: turn complete
    const res3 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            turnComplete: true,
          },
        }),
      ),
    );
    expect(res3).toEqual([
      {
        content: {
          role: 'model',
          parts: [{text: 'Answer is 42.'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should handle input transcription partial and finished', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res1 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            inputTranscription: {text: 'hello', finished: false},
          },
        }),
      ),
    );
    expect(res1).toEqual([
      {
        inputTranscription: {text: 'hello', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);

    const res2 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            inputTranscription: {text: ' world', finished: true},
          },
        }),
      ),
    );
    expect(res2).toEqual([
      {
        inputTranscription: {text: ' world', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        inputTranscription: {text: 'hello world', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should flush pending transcription on interrupted', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res1 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            inputTranscription: {text: 'hello', finished: false},
          },
        }),
      ),
    );
    expect(res1[0].inputTranscription).toEqual({
      text: 'hello',
      finished: false,
    });

    const res2 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            interrupted: true,
          },
        }),
      ),
    );
    expect(res2).toEqual([
      {
        inputTranscription: {text: 'hello', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        interrupted: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should yield groundingMetadata on partial response', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res1 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: 'Partial text'}],
            },
            groundingMetadata: {
              groundingChunks: [
                {web: {uri: 'https://google.com', title: 'Google'}},
              ],
            } as GroundingMetadata,
          },
        }),
      ),
    );
    expect(res1).toEqual([
      {
        content: {parts: [{text: 'Partial text'}]},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
        groundingMetadata: {
          groundingChunks: [
            {web: {uri: 'https://google.com', title: 'Google'}},
          ],
        },
      },
    ]);
  });

  it('should buffer tool calls and yield at turnComplete for non-Gemini 3.x', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res1 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          toolCall: {
            functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
          },
        }),
      ),
    );
    expect(res1).toEqual([]); // Buffered

    const res2 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            turnComplete: true,
          },
        }),
      ),
    );
    expect(res2).toEqual([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      },
      {
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should yield tool calls immediately for Gemini 3.x', () => {
    const aggregator = new LiveResponseAggregator('gemini-3.1-flash-live');

    const res1 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          toolCall: {
            functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
          },
        }),
      ),
    );
    expect(res1).toEqual([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-3.1-flash-live',
      },
    ]);
  });

  it('should yield session resumption update', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const resumptionUpdate = {resumable: true};

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({sessionResumptionUpdate: resumptionUpdate}),
      ),
    );
    expect(res).toEqual([
      {
        liveSessionResumptionUpdate: resumptionUpdate,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should yield go away', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const goAway: LiveServerGoAway = {timeLeft: '10s'};

    const res = Array.from(
      aggregator.processMessage(liveServerMessage({goAway})),
    );
    expect(res).toEqual([
      {
        goAway,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should remap live output token counts onto the candidates fields', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const usageMetadata: UsageMetadata = {
      promptTokenCount: 10,
      cachedContentTokenCount: 3,
      responseTokenCount: 20,
      totalTokenCount: 33,
      thoughtsTokenCount: 5,
      toolUsePromptTokenCount: 2,
      promptTokensDetails: [{modality: MediaModality.TEXT, tokenCount: 10}],
      cacheTokensDetails: [{modality: MediaModality.TEXT, tokenCount: 3}],
      responseTokensDetails: [{modality: MediaModality.AUDIO, tokenCount: 20}],
      toolUsePromptTokensDetails: [
        {modality: MediaModality.TEXT, tokenCount: 2},
      ],
      trafficType: TrafficType.ON_DEMAND,
      serviceTier: ServiceTier.STANDARD,
    };

    const res = Array.from(
      aggregator.processMessage(liveServerMessage({usageMetadata})),
    );

    expect(res).toHaveLength(1);
    expect(res[0].usageMetadata).toEqual({
      promptTokenCount: 10,
      cachedContentTokenCount: 3,
      candidatesTokenCount: 20,
      totalTokenCount: 33,
      thoughtsTokenCount: 5,
      toolUsePromptTokenCount: 2,
      promptTokensDetails: [{modality: MediaModality.TEXT, tokenCount: 10}],
      cacheTokensDetails: [{modality: MediaModality.TEXT, tokenCount: 3}],
      candidatesTokensDetails: [
        {modality: MediaModality.AUDIO, tokenCount: 20},
      ],
      toolUsePromptTokensDetails: [
        {modality: MediaModality.TEXT, tokenCount: 2},
      ],
      trafficType: TrafficType.ON_DEMAND,
    });
    expect(res[0].usageMetadata).not.toHaveProperty('responseTokenCount');
    expect(res[0].usageMetadata).not.toHaveProperty('responseTokensDetails');
    expect(res[0].usageMetadata).not.toHaveProperty('serviceTier');
  });

  it('should accumulate grounding metadata across the messages of a turn', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: 'part1'}]},
            groundingMetadata: {retrievalQueries: ['query1']},
          },
        }),
      ),
    );
    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: ' part2'}]},
            groundingMetadata: {
              retrievalQueries: ['query2'],
              groundingChunks: [{web: {uri: 'https://example.com'}}],
            },
          },
        }),
      ),
    );

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    expect(res).toEqual([
      {
        content: {role: 'model', parts: [{text: 'part1 part2'}]},
        partial: false,
        groundingMetadata: {
          retrievalQueries: ['query1', 'query2'],
          groundingChunks: [{web: {uri: 'https://example.com'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      },
      {
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should deduplicate queries and shift support indices when merging grounding metadata', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const grounding1: GroundingMetadata = {
      retrievalQueries: ['query1'],
      groundingChunks: [{web: {uri: 'https://example.com/1'}}],
      groundingSupports: [
        {
          segment: {startIndex: 0, endIndex: 5, text: 'hello'},
          groundingChunkIndices: [0],
        },
      ],
    };
    const grounding2: GroundingMetadata = {
      retrievalQueries: ['query1', 'query2'],
      groundingChunks: [{web: {uri: 'https://example.com/2'}}],
      groundingSupports: [
        {
          segment: {startIndex: 6, endIndex: 11, text: 'world'},
          groundingChunkIndices: [0],
        },
      ],
    };

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: 'hello'}]},
            groundingMetadata: grounding1,
          },
        }),
      ),
    );
    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: ' world'}]},
            groundingMetadata: grounding2,
          },
        }),
      ),
    );
    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    const merged = res[0].groundingMetadata;
    expect(res[0].content?.parts?.[0].text).toBe('hello world');
    expect(merged?.retrievalQueries).toEqual(['query1', 'query2']);
    expect(merged?.groundingChunks).toEqual([
      {web: {uri: 'https://example.com/1'}},
      {web: {uri: 'https://example.com/2'}},
    ]);
    expect(merged?.groundingSupports?.[0].groundingChunkIndices).toEqual([0]);
    expect(merged?.groundingSupports?.[1].groundingChunkIndices).toEqual([1]);

    expect(grounding1.retrievalQueries).toEqual(['query1']);
    expect(grounding1.groundingChunks).toHaveLength(1);
    expect(grounding2.groundingSupports?.[0].groundingChunkIndices).toEqual([
      0,
    ]);
  });

  it('should merge the non-accumulating grounding fields by overwriting them', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: 'hello'}]},
            groundingMetadata: {
              webSearchQueries: ['first'],
              imageSearchQueries: ['picture'],
              googleMapsWidgetContextToken: 'token-1',
              searchEntryPoint: {renderedContent: '<div>first</div>'},
              retrievalMetadata: {googleSearchDynamicRetrievalScore: 0.1},
              sourceFlaggingUris: [{sourceId: 'source-1'}],
              groundingSupports: [{segment: {text: 'hello'}}],
            },
          },
        }),
      ),
    );
    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: ' world'}]},
            groundingMetadata: {
              webSearchQueries: ['first', 'second'],
              googleMapsWidgetContextToken: 'token-2',
              searchEntryPoint: {renderedContent: '<div>second</div>'},
              retrievalMetadata: {googleSearchDynamicRetrievalScore: 0.9},
              sourceFlaggingUris: [{sourceId: 'source-2'}],
              groundingSupports: [{segment: {text: 'world'}}],
            },
          },
        }),
      ),
    );
    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    expect(res[0].groundingMetadata).toEqual({
      webSearchQueries: ['first', 'second'],
      imageSearchQueries: ['picture'],
      googleMapsWidgetContextToken: 'token-2',
      searchEntryPoint: {renderedContent: '<div>second</div>'},
      retrievalMetadata: {googleSearchDynamicRetrievalScore: 0.9},
      sourceFlaggingUris: [{sourceId: 'source-2'}],
      groundingSupports: [
        {segment: {text: 'hello'}},
        {segment: {text: 'world'}},
      ],
    });
  });

  it('should not carry grounding metadata into the next turn', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: 'grounded'}]},
            groundingMetadata: {retrievalQueries: ['query1']},
          },
        }),
      ),
    );
    Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {modelTurn: {parts: [{text: 'plain'}]}},
        }),
      ),
    );
    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    expect(res).toEqual([
      {
        content: {role: 'model', parts: [{text: 'plain'}]},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should yield the turn complete reason on the turnComplete response', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            turnComplete: true,
            turnCompleteReason: TurnCompleteReason.RESPONSE_REJECTED,
          },
        }),
      ),
    );

    expect(res).toEqual([
      {
        turnComplete: true,
        turnCompleteReason: TurnCompleteReason.RESPONSE_REJECTED,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should yield the turn complete reason on a standalone grounding response', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            groundingMetadata: {retrievalQueries: ['query1']},
            turnComplete: false,
            turnCompleteReason: TurnCompleteReason.RESPONSE_REJECTED,
          },
        }),
      ),
    );

    expect(res).toEqual([
      {
        groundingMetadata: {retrievalQueries: ['query1']},
        turnCompleteReason: TurnCompleteReason.RESPONSE_REJECTED,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should yield the turn complete reason on a content response', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: 'hello'}]},
            turnCompleteReason: TurnCompleteReason.RESPONSE_REJECTED,
          },
        }),
      ),
    );

    expect(res).toEqual([
      {
        content: {parts: [{text: 'hello'}]},
        partial: true,
        turnCompleteReason: TurnCompleteReason.RESPONSE_REJECTED,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  for (const interactionStatus of [
    InteractionStatus.IN_PROGRESS,
    InteractionStatus.IDLE,
  ]) {
    it(`should yield the interaction status ${interactionStatus} on the turnComplete response`, () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
      const serverContent: LiveServerContentWithStatus = {
        turnComplete: true,
        interactionStatus,
      };

      const res = Array.from(
        aggregator.processMessage(liveServerMessage({serverContent})),
      );

      expect(res).toEqual([
        {
          turnComplete: true,
          interactionStatus,
          modelVersion: 'gemini-2.5-flash',
        },
      ]);
    });
  }

  it('should omit the interaction status when the server sends none', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    expect(res).toHaveLength(1);
    expect(res[0]).not.toHaveProperty('interactionStatus');
  });

  it('should yield voice activity', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const voiceActivity: VoiceActivity = {
      voiceActivityType: VoiceActivityType.ACTIVITY_START,
      audioOffset: '1.5s',
    };

    const res = Array.from(
      aggregator.processMessage(liveServerMessage({voiceActivity})),
    );

    expect(res).toEqual([
      {
        voiceActivity,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should emit one final input transcription for Gemini 3.x Live', () => {
    const aggregator = new LiveResponseAggregator(
      'gemini-3.1-flash-live-preview',
    );

    const res1 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            inputTranscription: {text: 'hello world', finished: true},
          },
        }),
      ),
    );
    expect(res1).toEqual([
      {
        inputTranscription: {text: 'hello world', finished: true},
        partial: false,
        modelVersion: 'gemini-3.1-flash-live-preview',
      },
    ]);

    const res2 = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );
    expect(res2).toEqual([
      {
        turnComplete: true,
        groundingMetadata: {},
        modelVersion: 'gemini-3.1-flash-live-preview',
      },
    ]);
  });

  it('should yield nothing for a text-less input transcription on Gemini 3.x Live', () => {
    const aggregator = new LiveResponseAggregator(
      'gemini-3.1-flash-live-preview',
    );

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {inputTranscription: {finished: true}},
        }),
      ),
    );

    expect(res).toEqual([]);
  });

  it('should default the grounding metadata to an empty object for Gemini 3.x Live', () => {
    const aggregator = new LiveResponseAggregator(
      'gemini-3.1-flash-live-preview',
    );

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    expect(res).toEqual([
      {
        turnComplete: true,
        groundingMetadata: {},
        modelVersion: 'gemini-3.1-flash-live-preview',
      },
    ]);
  });

  it('should leave the grounding metadata absent for a non-Gemini 3.x model', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    expect(res).toHaveLength(1);
    expect(res[0]).not.toHaveProperty('groundingMetadata');
  });

  it('should warn once about incomplete grounding metadata, at turnComplete', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: 'hello'}]},
            groundingMetadata: {retrievalQueries: ['query1']},
          },
        }),
      ),
    );
    expect(warnSpy).not.toHaveBeenCalled();

    Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('query1');
  });

  it('should not warn when the grounding metadata carries chunks', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            turnComplete: true,
            groundingMetadata: {
              retrievalQueries: ['query1'],
              groundingChunks: [{web: {uri: 'https://example.com'}}],
            },
          },
        }),
      ),
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should keep the interrupted flag and the grounding on a flushed text response', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: 'Hello'}]},
            groundingMetadata: {retrievalQueries: ['query1']},
          },
        }),
      ),
    );

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {interrupted: true}}),
      ),
    );

    expect(res).toEqual([
      {
        content: {role: 'model', parts: [{text: 'Hello'}]},
        partial: false,
        interrupted: true,
        groundingMetadata: {retrievalQueries: ['query1']},
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should keep the interrupted flag on a text flush caused by turnComplete', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {modelTurn: {parts: [{text: 'Hello'}]}},
        }),
      ),
    );

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {turnComplete: true, interrupted: true},
        }),
      ),
    );

    expect(res).toEqual([
      {
        content: {role: 'model', parts: [{text: 'Hello'}]},
        partial: false,
        interrupted: true,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        turnComplete: true,
        interrupted: true,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        interrupted: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should clear the grounding the turnComplete response itself carried', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const groundingMetadata: GroundingMetadata = {
      retrievalQueries: ['query1'],
      groundingChunks: [{web: {uri: 'https://example.com'}}],
    };

    Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {groundingMetadata}}),
      ),
    );
    const res1 = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );
    expect(res1).toEqual([
      {
        turnComplete: true,
        groundingMetadata,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);

    const res2 = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );
    expect(res2).toEqual([
      {
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should attach the accumulated grounding to an interrupt with no pending text', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {groundingMetadata: {retrievalQueries: ['query1']}},
        }),
      ),
    );

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {interrupted: true}}),
      ),
    );

    expect(res).toEqual([
      {
        interrupted: true,
        groundingMetadata: {retrievalQueries: ['query1']},
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should carry the grounding on a buffered tool call and clear it afterwards', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
    const groundingMetadata: GroundingMetadata = {
      retrievalQueries: ['test query'],
    };

    Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {groundingMetadata}}),
      ),
    );
    expect(
      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            toolCall: {
              functionCalls: [{name: 'test_function', args: {param: 'value'}}],
            },
          }),
        ),
      ),
    ).toEqual([]);

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    expect(res).toEqual([
      {
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'test_function', args: {param: 'value'}}},
          ],
        },
        groundingMetadata,
        modelVersion: 'gemini-2.5-flash',
      },
      {
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should carry the grounding on an immediate Gemini 3.x tool call and clear it afterwards', () => {
    const aggregator = new LiveResponseAggregator(
      'gemini-3.1-flash-live-preview',
    );
    const groundingMetadata: GroundingMetadata = {
      retrievalQueries: ['test query'],
    };

    Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {groundingMetadata}}),
      ),
    );

    const res1 = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          toolCall: {
            functionCalls: [{name: 'test_function', args: {param: 'value'}}],
          },
        }),
      ),
    );
    expect(res1).toEqual([
      {
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'test_function', args: {param: 'value'}}},
          ],
        },
        groundingMetadata,
        modelVersion: 'gemini-3.1-flash-live-preview',
      },
    ]);

    const res2 = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );
    expect(res2).toEqual([
      {
        turnComplete: true,
        groundingMetadata: {},
        modelVersion: 'gemini-3.1-flash-live-preview',
      },
    ]);
  });

  it('should flush the pending text with the grounding when a tool call arrives', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: 'Hello'}]},
            groundingMetadata: {retrievalQueries: ['query1']},
          },
        }),
      ),
    );

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          toolCall: {functionCalls: [{name: 'tool_a', args: {}, id: '1'}]},
        }),
      ),
    );

    expect(res).toEqual([
      {
        content: {role: 'model', parts: [{text: 'Hello'}]},
        partial: false,
        groundingMetadata: {retrievalQueries: ['query1']},
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should flush the pending text with the grounding on a non-text model turn', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: 'Hello'}]},
            groundingMetadata: {retrievalQueries: ['query1']},
          },
        }),
      ),
    );

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{functionCall: {name: 'tool_a', id: '1'}}]},
          },
        }),
      ),
    );

    expect(res).toEqual([
      {
        content: {role: 'model', parts: [{text: 'Hello'}]},
        partial: false,
        groundingMetadata: {retrievalQueries: ['query1']},
        modelVersion: 'gemini-2.5-flash',
      },
      {
        content: {parts: [{functionCall: {name: 'tool_a', id: '1'}}]},
        modelVersion: 'gemini-2.5-flash',
      },
    ]);
  });

  it('should merge grounding fields the accumulator does not have yet', () => {
    const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: 'hello'}]},
            groundingMetadata: {
              groundingChunks: [{web: {uri: 'https://example.com/1'}}],
            },
          },
        }),
      ),
    );
    Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            modelTurn: {parts: [{text: ' world'}]},
            groundingMetadata: {
              retrievalQueries: ['query1'],
              groundingSupports: [{groundingChunkIndices: [0]}],
            },
          },
        }),
      ),
    );
    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({serverContent: {turnComplete: true}}),
      ),
    );

    expect(res[0].groundingMetadata).toEqual({
      retrievalQueries: ['query1'],
      groundingChunks: [{web: {uri: 'https://example.com/1'}}],
      groundingSupports: [{groundingChunkIndices: [1]}],
    });
  });

  it('should omit the model version from every response when it has none', () => {
    const aggregator = new LiveResponseAggregator();
    const voiceActivity: VoiceActivity = {
      voiceActivityType: VoiceActivityType.ACTIVITY_END,
    };
    const messages = [
      liveServerMessage({usageMetadata: {responseTokenCount: 20}}),
      liveServerMessage({
        serverContent: {groundingMetadata: {webSearchQueries: ['query1']}},
      }),
      liveServerMessage({
        serverContent: {
          modelTurn: {parts: [{text: 'hello'}]},
          inputTranscription: {text: 'ask', finished: true},
          outputTranscription: {text: 'answer', finished: true},
        },
      }),
      liveServerMessage({
        serverContent: {
          inputTranscription: {text: 'and more'},
          outputTranscription: {text: 'and more'},
        },
      }),
      liveServerMessage({
        toolCall: {functionCalls: [{name: 'tool_a', id: '1'}]},
      }),
      liveServerMessage({serverContent: {turnComplete: true}}),
      liveServerMessage({serverContent: {interrupted: true}}),
      liveServerMessage({sessionResumptionUpdate: {resumable: true}}),
      liveServerMessage({voiceActivity}),
      liveServerMessage({goAway: {timeLeft: '10s'}}),
    ];

    const res = messages.flatMap((message) =>
      Array.from(aggregator.processMessage(message)),
    );

    expect(res.length).toBeGreaterThan(messages.length);
    for (const response of res) {
      expect(response).not.toHaveProperty('modelVersion');
    }
    expect(res).toContainEqual({voiceActivity});
  });

  it('should route a Gemini 3.x live model without flash down the 3.x path', () => {
    const aggregator = new LiveResponseAggregator('gemini-3.1-live-preview');

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            inputTranscription: {text: 'hello world', finished: true},
          },
        }),
      ),
    );

    expect(res).toEqual([
      {
        inputTranscription: {text: 'hello world', finished: true},
        partial: false,
        modelVersion: 'gemini-3.1-live-preview',
      },
    ]);
  });

  it('should keep a Gemini 3.5 live translate model off the 3.x path', () => {
    const aggregator = new LiveResponseAggregator(
      'gemini-3.5-live-translate-preview',
    );

    const res = Array.from(
      aggregator.processMessage(
        liveServerMessage({
          serverContent: {
            inputTranscription: {text: 'hello world', finished: true},
          },
        }),
      ),
    );

    expect(res).toEqual([
      {
        inputTranscription: {text: 'hello world', finished: false},
        partial: true,
        modelVersion: 'gemini-3.5-live-translate-preview',
      },
      {
        inputTranscription: {text: 'hello world', finished: true},
        partial: false,
        modelVersion: 'gemini-3.5-live-translate-preview',
      },
    ]);
  });
});
