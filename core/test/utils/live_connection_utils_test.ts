/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InteractionStatus} from '@google/adk';
import {
  GroundingMetadata,
  LiveServerContent,
  LiveServerGoAway,
  MediaModality,
  TrafficType,
  TurnCompleteReason,
  UsageMetadata,
  VoiceActivity,
  VoiceActivityType,
} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {LiveResponseAggregator} from '../../src/utils/live_connection_utils.js';
import {logger} from '../../src/utils/logger.js';
import {liveServerMessage} from './live_server_message_test_utils.js';

/**
 * `LiveServerContent` with the activity state that `@google/genai` 2.9.0 does
 * not declare yet, so a test can send what the live API sends.
 */
interface LiveServerContentWithInteractionStatus extends LiveServerContent {
  interactionStatus?: InteractionStatus;
}

function withInteractionStatus(
  serverContent: LiveServerContent,
  interactionStatus: InteractionStatus,
): LiveServerContentWithInteractionStatus {
  return {...serverContent, interactionStatus};
}

describe('LiveResponseAggregator', () => {
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
    // The ' world!' part is folded into the flushed full text, so it is not
    // yielded again as a partial response.
    expect(res2).toEqual([
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

  describe('usage metadata', () => {
    it('should remap the live output token fields', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
      const responseTokensDetails = [
        {modality: MediaModality.AUDIO, tokenCount: 20},
      ];

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            usageMetadata: {responseTokenCount: 20, responseTokensDetails},
          }),
        ),
      );

      expect(res[0].usageMetadata).toMatchObject({
        candidatesTokenCount: 20,
        candidatesTokensDetails: responseTokensDetails,
      });
    });

    it('should carry the remaining fields unchanged', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
      const usageMetadata: UsageMetadata = {
        promptTokenCount: 1,
        cachedContentTokenCount: 2,
        totalTokenCount: 3,
        thoughtsTokenCount: 4,
        toolUsePromptTokenCount: 5,
        promptTokensDetails: [{modality: MediaModality.TEXT, tokenCount: 1}],
        cacheTokensDetails: [{modality: MediaModality.TEXT, tokenCount: 2}],
        toolUsePromptTokensDetails: [
          {modality: MediaModality.TEXT, tokenCount: 5},
        ],
        trafficType: TrafficType.ON_DEMAND,
      };

      const res = Array.from(
        aggregator.processMessage(liveServerMessage({usageMetadata})),
      );

      expect(res[0].usageMetadata).toEqual({
        ...usageMetadata,
        candidatesTokenCount: undefined,
        candidatesTokensDetails: undefined,
      });
    });
  });

  describe('grounding metadata', () => {
    it('should accumulate chunks, de-duplicate queries and shift the support indices', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              groundingMetadata: {
                retrievalQueries: ['weather', 'tokyo'],
                groundingChunks: [
                  {web: {uri: 'https://a.example', title: 'A'}},
                ],
                groundingSupports: [{groundingChunkIndices: [0]}],
              },
            },
          }),
        ),
      );
      // The second message repeats one query and adds one chunk of its own.
      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              groundingMetadata: {
                retrievalQueries: ['tokyo', 'kyoto'],
                groundingChunks: [
                  {web: {uri: 'https://b.example', title: 'B'}},
                ],
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
        retrievalQueries: ['weather', 'tokyo', 'kyoto'],
        groundingChunks: [
          {web: {uri: 'https://a.example', title: 'A'}},
          {web: {uri: 'https://b.example', title: 'B'}},
        ],
        groundingSupports: [
          {groundingChunkIndices: [0]},
          {groundingChunkIndices: [1]},
        ],
      });
    });

    it('should start a new turn with no accumulated metadata', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              groundingMetadata: {
                groundingChunks: [
                  {web: {uri: 'https://a.example', title: 'A'}},
                ],
              },
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
            serverContent: {
              groundingMetadata: {
                groundingChunks: [
                  {web: {uri: 'https://b.example', title: 'B'}},
                ],
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
        groundingChunks: [{web: {uri: 'https://b.example', title: 'B'}}],
      });
    });

    it('should merge across messages and reach the flushed full text', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              modelTurn: {parts: [{text: 'Tokyo is '}]},
              groundingMetadata: {
                retrievalQueries: ['weather', 'tokyo'],
                groundingChunks: [
                  {web: {uri: 'https://a.example', title: 'A'}},
                ],
                groundingSupports: [{groundingChunkIndices: [0]}],
              },
            },
          }),
        ),
      );
      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              modelTurn: {parts: [{text: 'sunny.'}]},
              groundingMetadata: {
                retrievalQueries: ['tokyo', 'kyoto'],
                groundingChunks: [
                  {web: {uri: 'https://b.example', title: 'B'}},
                ],
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

      expect(res[0].content).toEqual({
        role: 'model',
        parts: [{text: 'Tokyo is sunny.'}],
      });
      expect(res[0].groundingMetadata).toEqual({
        retrievalQueries: ['weather', 'tokyo', 'kyoto'],
        groundingChunks: [
          {web: {uri: 'https://a.example', title: 'A'}},
          {web: {uri: 'https://b.example', title: 'B'}},
        ],
        groundingSupports: [
          {groundingChunkIndices: [0]},
          {groundingChunkIndices: [1]},
        ],
      });
    });

    it('should merge into metadata that carries no chunk yet', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {groundingMetadata: {retrievalQueries: ['tokyo']}},
          }),
        ),
      );
      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              groundingMetadata: {
                retrievalQueries: ['kyoto'],
                groundingChunks: [
                  {web: {uri: 'https://a.example', title: 'A'}},
                ],
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
        retrievalQueries: ['tokyo', 'kyoto'],
        groundingChunks: [{web: {uri: 'https://a.example', title: 'A'}}],
        groundingSupports: [{groundingChunkIndices: [0]}],
      });
    });

    it('should add the queries of a later message to metadata that had none', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              groundingMetadata: {
                groundingChunks: [
                  {web: {uri: 'https://a.example', title: 'A'}},
                ],
              },
            },
          }),
        ),
      );
      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              groundingMetadata: {webSearchQueries: ['tokyo']},
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
        groundingChunks: [{web: {uri: 'https://a.example', title: 'A'}}],
        webSearchQueries: ['tokyo'],
      });
    });

    it('should carry the accumulated metadata onto an interruption', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
      const groundingMetadata: GroundingMetadata = {
        groundingChunks: [{web: {uri: 'https://a.example', title: 'A'}}],
      };

      Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {groundingMetadata}}),
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
          groundingMetadata,
          modelVersion: 'gemini-2.5-flash',
        },
      ]);
    });

    it('should keep a support that cites no chunk', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              groundingMetadata: {
                groundingChunks: [
                  {web: {uri: 'https://a.example', title: 'A'}},
                ],
              },
            },
          }),
        ),
      );
      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              groundingMetadata: {
                groundingSupports: [{segment: {text: 'no citation'}}],
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
        groundingChunks: [{web: {uri: 'https://a.example', title: 'A'}}],
        groundingSupports: [{segment: {text: 'no citation'}}],
      });
    });

    it('should warn once, at turnComplete, about incomplete grounding', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              groundingMetadata: {retrievalQueries: ['tokyo weather']},
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
      expect(warnSpy.mock.calls[0][0]).toContain('tokyo weather');
      warnSpy.mockRestore();
    });

    it('should not warn when the metadata carries chunks', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              turnComplete: true,
              groundingMetadata: {
                retrievalQueries: ['tokyo weather'],
                groundingChunks: [
                  {web: {uri: 'https://a.example', title: 'A'}},
                ],
              },
            },
          }),
        ),
      );

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should default to empty metadata at turnComplete for Gemini 3.x Live', () => {
      const aggregator = new LiveResponseAggregator('gemini-3.1-live-preview');

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {turnComplete: true}}),
        ),
      );

      expect(res).toEqual([
        {
          turnComplete: true,
          groundingMetadata: {},
          modelVersion: 'gemini-3.1-live-preview',
        },
      ]);
    });

    it('should omit the metadata at turnComplete for other models', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {turnComplete: true}}),
        ),
      );

      expect(res[0]).not.toHaveProperty('groundingMetadata');
    });
  });

  describe('tool call grounding metadata', () => {
    it('should attach it to the buffered call and not to turnComplete', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
      const groundingMetadata: GroundingMetadata = {
        groundingChunks: [{web: {uri: 'https://a.example', title: 'A'}}],
      };

      Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {groundingMetadata}}),
        ),
      );
      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            toolCall: {functionCalls: [{name: 'tool_a', args: {}, id: '1'}]},
          }),
        ),
      );
      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {turnComplete: true}}),
        ),
      );

      expect(res[0]).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {}, id: '1'}}],
        },
        groundingMetadata,
        modelVersion: 'gemini-2.5-flash',
      });
      expect(res[1]).not.toHaveProperty('groundingMetadata');
    });

    it('should attach it to the immediate call for Gemini 3.x Live', () => {
      const aggregator = new LiveResponseAggregator('gemini-3.1-live-preview');
      const groundingMetadata: GroundingMetadata = {
        groundingChunks: [{web: {uri: 'https://a.example', title: 'A'}}],
      };

      Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {groundingMetadata}}),
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
          content: {
            role: 'model',
            parts: [{functionCall: {name: 'tool_a', args: {}, id: '1'}}],
          },
          groundingMetadata,
          modelVersion: 'gemini-3.1-live-preview',
        },
      ]);
    });

    it('should yield a non-flash Gemini 3.x Live tool call immediately', () => {
      const aggregator = new LiveResponseAggregator('gemini-3.1-live-preview');

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            toolCall: {functionCalls: [{name: 'tool_a', args: {}, id: '1'}]},
          }),
        ),
      );

      expect(res).toEqual([
        {
          content: {
            role: 'model',
            parts: [{functionCall: {name: 'tool_a', args: {}, id: '1'}}],
          },
          modelVersion: 'gemini-3.1-live-preview',
        },
      ]);
    });
  });

  describe('input transcription', () => {
    it('should emit one finished transcription for Gemini 3.x Live', () => {
      const aggregator = new LiveResponseAggregator('gemini-3.1-live-preview');

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {inputTranscription: {text: 'hello there'}},
          }),
        ),
      );

      expect(res).toEqual([
        {
          inputTranscription: {text: 'hello there', finished: true},
          partial: false,
          modelVersion: 'gemini-3.1-live-preview',
        },
      ]);
    });

    it('should not buffer the Gemini 3.x Live transcription across the turn', () => {
      const aggregator = new LiveResponseAggregator('gemini-3.1-live-preview');

      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {inputTranscription: {text: 'hello there'}},
          }),
        ),
      );
      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {generationComplete: true}}),
        ),
      );

      expect(res).toEqual([]);
    });
  });

  describe('turn completion fields', () => {
    it('should report the turn complete reason on the final response', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              turnComplete: true,
              turnCompleteReason: TurnCompleteReason.MALFORMED_FUNCTION_CALL,
            },
          }),
        ),
      );

      expect(res[0].turnCompleteReason).toBe(
        TurnCompleteReason.MALFORMED_FUNCTION_CALL,
      );
    });

    it('should report the turn complete reason on a standalone grounding response', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              groundingMetadata: {webSearchQueries: ['tokyo']},
              turnCompleteReason: TurnCompleteReason.RESPONSE_REJECTED,
            },
          }),
        ),
      );

      expect(res[0].turnCompleteReason).toBe(
        TurnCompleteReason.RESPONSE_REJECTED,
      );
    });

    it('should report the turn complete reason on a content response', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              modelTurn: {parts: [{text: 'Hello'}]},
              turnCompleteReason: TurnCompleteReason.RESPONSE_REJECTED,
            },
          }),
        ),
      );

      expect(res[0].turnCompleteReason).toBe(
        TurnCompleteReason.RESPONSE_REJECTED,
      );
    });

    it.each([InteractionStatus.IN_PROGRESS, InteractionStatus.IDLE])(
      'should report the interaction status %s',
      (interactionStatus) => {
        const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

        const res = Array.from(
          aggregator.processMessage(
            liveServerMessage({
              serverContent: withInteractionStatus(
                {turnComplete: true},
                interactionStatus,
              ),
            }),
          ),
        );

        expect(res[0].interactionStatus).toBe(interactionStatus);
      },
    );

    it('should omit the interaction status when the model does not report it', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {turnComplete: true}}),
        ),
      );

      expect(res[0]).not.toHaveProperty('interactionStatus');
    });
  });

  describe('flushed parts', () => {
    it('should keep only the unflushed part of a multiplexed message', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              modelTurn: {
                parts: [
                  {text: 'Thinking...', thought: true},
                  {text: 'Answer is 42.'},
                ],
              },
            },
          }),
        ),
      );

      expect(res).toEqual([
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
          partial: true,
          modelVersion: 'gemini-2.5-flash',
        },
      ]);
    });

    it('should still yield a content response that holds no text', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');
      const inlineData = {mimeType: 'audio/pcm', data: 'base64audio'};

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {modelTurn: {parts: [{inlineData}]}},
          }),
        ),
      );

      expect(res).toEqual([
        {
          content: {parts: [{inlineData}]},
          modelVersion: 'gemini-2.5-flash',
        },
      ]);
    });

    it('should still yield a content response that holds only a thought', () => {
      const aggregator = new LiveResponseAggregator('gemini-2.5-flash');

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              modelTurn: {
                role: 'model',
                parts: [{text: 'plan', thought: true}],
              },
              turnComplete: true,
            },
          }),
        ),
      );

      expect(res).toEqual([
        {
          content: {role: 'model', parts: [{text: 'plan', thought: true}]},
          partial: false,
          modelVersion: 'gemini-2.5-flash',
        },
        {
          turnComplete: true,
          modelVersion: 'gemini-2.5-flash',
        },
      ]);
    });

    it('should carry the interrupted flag onto the flushed text', () => {
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
          liveServerMessage({serverContent: {interrupted: true}}),
        ),
      );

      expect(res).toEqual([
        {
          content: {role: 'model', parts: [{text: 'Hello'}]},
          partial: false,
          interrupted: true,
          modelVersion: 'gemini-2.5-flash',
        },
      ]);
    });
  });

  describe('without a model version', () => {
    it('should omit it from a completed turn', () => {
      const aggregator = new LiveResponseAggregator();

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
            serverContent: {
              modelTurn: {parts: [{inlineData: {mimeType: 'audio/pcm'}}]},
              turnComplete: true,
            },
          }),
        ),
      );

      expect(res).toEqual([
        {content: {parts: [{inlineData: {mimeType: 'audio/pcm'}}]}},
        {content: {role: 'model', parts: [{text: 'Hello'}]}, partial: false},
        {turnComplete: true},
      ]);
    });

    it('should omit it from the transcriptions', () => {
      const aggregator = new LiveResponseAggregator();

      const fragments = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              inputTranscription: {text: 'hi'},
              outputTranscription: {text: 'hello'},
            },
          }),
        ),
      );
      const flushed = Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {generationComplete: true}}),
        ),
      );

      expect(fragments).toEqual([
        {
          inputTranscription: {text: 'hi', finished: false},
          partial: true,
        },
        {
          outputTranscription: {text: 'hello', finished: false},
          partial: true,
        },
      ]);
      expect(flushed).toEqual([
        {inputTranscription: {text: 'hi', finished: true}, partial: false},
        {
          outputTranscription: {text: 'hello', finished: true},
          partial: false,
        },
      ]);
    });

    it('should omit it from a finished transcription', () => {
      const aggregator = new LiveResponseAggregator();

      const res = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            serverContent: {
              inputTranscription: {text: 'hi', finished: true},
              outputTranscription: {text: 'hello', finished: true},
            },
          }),
        ),
      );

      expect(res).toEqual([
        {inputTranscription: {text: 'hi', finished: false}, partial: true},
        {inputTranscription: {text: 'hi', finished: true}, partial: false},
        {
          outputTranscription: {text: 'hello', finished: false},
          partial: true,
        },
        {
          outputTranscription: {text: 'hello', finished: true},
          partial: false,
        },
      ]);
    });

    it('should omit it from the standalone signals', () => {
      const aggregator = new LiveResponseAggregator();
      const groundingMetadata: GroundingMetadata = {
        webSearchQueries: ['tokyo'],
      };

      const grounding = Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {groundingMetadata}}),
        ),
      );
      const interrupted = Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {interrupted: true}}),
        ),
      );
      const signals = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            usageMetadata: {responseTokenCount: 1},
            sessionResumptionUpdate: {resumable: true},
            voiceActivity: {voiceActivityType: VoiceActivityType.ACTIVITY_END},
            goAway: {timeLeft: '10s'},
          }),
        ),
      );

      expect(grounding).toEqual([{groundingMetadata}]);
      expect(interrupted).toEqual([{interrupted: true, groundingMetadata}]);
      expect(signals).toEqual([
        {usageMetadata: {candidatesTokenCount: 1}},
        {liveSessionResumptionUpdate: {resumable: true}},
        {voiceActivity: {voiceActivityType: VoiceActivityType.ACTIVITY_END}},
        {goAway: {timeLeft: '10s'}},
      ]);
    });

    it('should omit it from a tool call', () => {
      const aggregator = new LiveResponseAggregator();

      const buffered = Array.from(
        aggregator.processMessage(
          liveServerMessage({
            toolCall: {functionCalls: [{name: 'tool_a', args: {}, id: '1'}]},
          }),
        ),
      );
      const completed = Array.from(
        aggregator.processMessage(
          liveServerMessage({serverContent: {turnComplete: true}}),
        ),
      );

      expect(buffered).toEqual([]);
      expect(completed).toEqual([
        {
          content: {
            role: 'model',
            parts: [{functionCall: {name: 'tool_a', args: {}, id: '1'}}],
          },
        },
        {turnComplete: true},
      ]);
    });

    it('should omit it from a tool call flushed on close', () => {
      const aggregator = new LiveResponseAggregator();

      Array.from(
        aggregator.processMessage(
          liveServerMessage({
            toolCall: {functionCalls: [{name: 'tool_a', args: {}, id: '1'}]},
          }),
        ),
      );
      const closed = Array.from(aggregator.close());

      expect(closed).toEqual([
        {
          content: {
            role: 'model',
            parts: [{functionCall: {name: 'tool_a', args: {}, id: '1'}}],
          },
        },
      ]);
    });
  });
});
