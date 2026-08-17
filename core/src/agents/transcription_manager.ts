/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turns live-streaming transcriptions into events.
 *
 * Ports `google/adk-python`'s `TranscriptionManager`, whose methods hold no
 * state, as module functions. They build events and count them, and never
 * write to the session: the caller owns the returned event and decides whether
 * to append it, yield it or drop it.
 */

import {Transcription} from '@google/genai';

import {Event, createEvent} from '../events/event.js';
import {getLogger} from '../utils/logger.js';
import {InvocationContext, requireAgent} from './invocation_context.js';

const logger = getLogger();

/** Which side of the conversation a transcription came from. */
type TranscriptionKind = 'input' | 'output';

/** Counts of transcription-bearing events recorded in a session. */
export interface TranscriptionStats {
  /** Number of events carrying an input (user speech) transcription. */
  inputTranscriptions: number;

  /** Number of events carrying an output (model speech) transcription. */
  outputTranscriptions: number;

  /** Sum of the input and output counts. */
  totalTranscriptions: number;
}

function createTranscriptionEvent(
  invocationContext: InvocationContext,
  transcription: Transcription,
  kind: TranscriptionKind,
): Event {
  // User speech is authored by 'user' rather than by the agent, because the
  // agent transcribes it but does not say it.
  const author =
    kind === 'input' ? 'user' : requireAgent(invocationContext).name;

  const event = createEvent({
    invocationId: invocationContext.invocationId,
    author,
    inputTranscription: kind === 'input' ? transcription : undefined,
    outputTranscription: kind === 'output' ? transcription : undefined,
  });

  logger.debug(
    `Created ${kind} transcription event for ${author}: ${
      transcription.text ?? 'audio transcription'
    }`,
  );

  return event;
}

/**
 * Builds the event for a transcription of user speech.
 *
 * @param invocationContext The current invocation context.
 * @param transcription The transcription of the user input.
 * @returns The event carrying the transcription, authored by `'user'`.
 */
export function handleInputTranscription(
  invocationContext: InvocationContext,
  transcription: Transcription,
): Event {
  return createTranscriptionEvent(invocationContext, transcription, 'input');
}

/**
 * Builds the event for a transcription of model speech.
 *
 * @param invocationContext The current invocation context.
 * @param transcription The transcription of the model output.
 * @returns The event carrying the transcription, authored by the agent.
 * @throws If the invocation runs a node directly and has no agent.
 */
export function handleOutputTranscription(
  invocationContext: InvocationContext,
  transcription: Transcription,
): Event {
  return createTranscriptionEvent(invocationContext, transcription, 'output');
}

/**
 * Counts the transcriptions already recorded in the session.
 *
 * @param invocationContext The current invocation context.
 * @returns The counts of input, output and total transcriptions.
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
