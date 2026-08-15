/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm, BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {LlmRecording, Recording} from './test_types.js';

const REPLAY_MODEL_NAME = 'replay-llm';

/** The LLM recordings of one agent within one user turn, in recorded order. */
function llmRecordingsFor(
  recordings: Recording[],
  agentName: string,
  userMessageIndex: number,
): LlmRecording[] {
  return recordings.flatMap((recording) =>
    recording.agentName === agentName &&
    recording.userMessageIndex === userMessageIndex &&
    recording.llmRecording
      ? [recording.llmRecording]
      : [],
  );
}

/**
 * A model that replays recorded responses instead of calling a real one.
 *
 * One call consumes one recording and yields every response it holds. A
 * recording made with StreamingMode.SSE holds the partial chunks and the
 * complete response of a single model call, so the runtime sees the same
 * response stream the recorder saw.
 */
export class ReplayLlm extends BaseLlm {
  private readonly agentName: string;
  private readonly recordings: Recording[];
  private readonly context: {userMessageIndex: number};

  /** The next recording to consume, per user turn. */
  private readonly nextIndexByTurn = new Map<number, number>();

  constructor(config: {
    agentName: string;
    recordings: Recording[];
    context: {userMessageIndex: number};
  }) {
    super({model: REPLAY_MODEL_NAME});
    this.agentName = config.agentName;
    this.recordings = config.recordings;
    this.context = config.context;
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'ReplayLlm.connect should not be called during replay tests.',
    );
  }

  async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const userMessageIndex = this.context.userMessageIndex;
    const turnRecordings = llmRecordingsFor(
      this.recordings,
      this.agentName,
      userMessageIndex,
    );
    const index = this.nextIndexByTurn.get(userMessageIndex) ?? 0;

    if (index >= turnRecordings.length) {
      throw new Error(
        `Runtime sent more LLM requests than expected for agent ` +
          `'${this.agentName}' at user message index ${userMessageIndex}. ` +
          `Expected ${turnRecordings.length}, but got request at index ${index}.`,
      );
    }
    this.nextIndexByTurn.set(userMessageIndex, index + 1);

    for (const response of turnRecordings[index].llmResponses ?? []) {
      yield response;
    }
  }
}
