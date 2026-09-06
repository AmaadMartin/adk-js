/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Fixtures shared by the {@link LlmAudioUserSimulator} test files. */

import {
  UserSimulatorStatus,
  type Event,
  type LlmResponse,
  type NextUserMessage,
  type UserSimulator,
} from '@google/adk';

/** Encodes bytes the way `@google/genai` carries them in `Blob.data`. */
export function encode(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString('base64');
}

/** Decodes a `Blob.data` payload back into bytes. */
export function decode(data: string | undefined): Uint8Array {
  return new Uint8Array(Buffer.from(data ?? '', 'base64'));
}

/** Builds an audio model response carrying one `inlineData` audio part. */
export function audioResponse(
  data: Uint8Array | string = 'AUDIO_BYTES',
  mimeType = 'audio/pcm',
): LlmResponse {
  return {
    content: {
      parts: [{inlineData: {mimeType, data: encode(data)}}],
      role: 'user',
    },
  };
}

/** A wrapped simulator that replays one scripted result per call. */
export class ScriptedUserSimulator implements UserSimulator {
  callCount = 0;

  constructor(private readonly results: NextUserMessage[]) {}

  async getNextUserMessage(_events: Event[]): Promise<NextUserMessage> {
    this.callCount++;
    return this.results[Math.min(this.callCount - 1, this.results.length - 1)];
  }
}

/** A SUCCESS result carrying one text part. */
export function textMessage(text: string): NextUserMessage {
  return {
    status: UserSimulatorStatus.SUCCESS,
    userMessage: {parts: [{text}], role: 'user'},
  };
}
