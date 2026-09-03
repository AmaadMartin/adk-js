/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Transcription} from '@google/genai';

import {Event, createEvent} from '../events/event.js';
import {getLogger} from '../utils/logger.js';
import {InvocationContext, requireAgent} from './invocation_context.js';

const logger = getLogger();

/** Which side of the conversation a transcription came from. */
type TranscriptionKind = 'input' | 'output';

/** The author of every input transcription event. */
const INPUT_TRANSCRIPTION_AUTHOR = 'user';

/** Logged in place of the text when the payload carries none. */
const UNTRANSCRIBED_TEXT = 'audio transcription';

/** Counts of transcription-bearing events recorded in a session. */
export interface TranscriptionStats {
  /** Number of events carrying an input (user speech) transcription. */
  inputTranscriptions: number;
  /** Number of events carrying an output (model speech) transcription. */
  outputTranscriptions: number;
  /** Sum of the input and output counts. */
  totalTranscriptions: number;
}

/**
 * Builds the event that carries a transcription in the slot named by `kind`.
 *
 * The event is returned, not appended: the caller decides whether the session
 * keeps it.
 */
function createTranscriptionEvent(
  invocationContext: InvocationContext,
  transcription: Transcription,
  author: string,
  kind: TranscriptionKind,
): Event {
  try {
    const transcriptionEvent = createEvent({
      invocationId: invocationContext.invocationId,
      author,
      inputTranscription: kind === 'input' ? transcription : undefined,
      outputTranscription: kind === 'output' ? transcription : undefined,
    });

    logger.debug(
      `Saved ${kind} transcription event for ${author}: ` +
        `${transcription.text ?? UNTRANSCRIBED_TEXT}`,
    );

    return transcriptionEvent;
  } catch (e: unknown) {
    logger.error(`Failed to save ${kind} transcription event: ${e}`);
    throw e;
  }
}

/**
 * Builds an event carrying a user input transcription, authored `'user'`.
 *
 * @param invocationContext The current invocation context.
 * @param transcription The transcription data from user input.
 */
export function handleInputTranscription(
  invocationContext: InvocationContext,
  transcription: Transcription,
): Event {
  return createTranscriptionEvent(
    invocationContext,
    transcription,
    INPUT_TRANSCRIPTION_AUTHOR,
    'input',
  );
}

/**
 * Builds an event carrying a model output transcription, authored with the
 * agent's name.
 *
 * @param invocationContext The current invocation context.
 * @param transcription The transcription data from model output.
 * @throws if the invocation has no agent.
 */
export function handleOutputTranscription(
  invocationContext: InvocationContext,
  transcription: Transcription,
): Event {
  const author = requireAgent(invocationContext).name;
  return createTranscriptionEvent(
    invocationContext,
    transcription,
    author,
    'output',
  );
}

/**
 * Counts the transcription-bearing events in the invocation's session.
 *
 * An event carrying both slots counts once on each side, so it contributes 2
 * to the total.
 *
 * @param invocationContext The current invocation context.
 */
export function getTranscriptionStats(
  invocationContext: InvocationContext,
): TranscriptionStats {
  let inputTranscriptions = 0;
  let outputTranscriptions = 0;

  for (const event of invocationContext.session.events) {
    if (event.inputTranscription) {
      inputTranscriptions++;
    }
    if (event.outputTranscription) {
      outputTranscriptions++;
    }
  }

  return {
    inputTranscriptions,
    outputTranscriptions,
    totalTranscriptions: inputTranscriptions + outputTranscriptions,
  };
}

/** Manages transcription events for live streaming flows. */
export class TranscriptionManager {
  handleInputTranscription(
    invocationContext: InvocationContext,
    transcription: Transcription,
  ): Event {
    return handleInputTranscription(invocationContext, transcription);
  }

  handleOutputTranscription(
    invocationContext: InvocationContext,
    transcription: Transcription,
  ): Event {
    return handleOutputTranscription(invocationContext, transcription);
  }

  getTranscriptionStats(
    invocationContext: InvocationContext,
  ): TranscriptionStats {
    return getTranscriptionStats(invocationContext);
  }
}
