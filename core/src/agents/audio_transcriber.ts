/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {SpeechClient} from '@google-cloud/speech';
import type {Content} from '@google/genai';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';
import {isContent} from '../workflow/base_node.js';
import type {InvocationContext} from './invocation_context.js';
import type {TranscriptionEntry} from './transcription_entry.js';

/** The role a transcript takes when its audio arrived with no role. */
const DEFAULT_ROLE = 'user';

/**
 * One unit of work produced by bundling the transcription cache: either audio
 * that needs a recognition request, or content that is already text.
 */
type BundledSegment =
  | {kind: 'audio'; speaker?: string; audio: Buffer}
  | {kind: 'content'; content: Content};

/** A run of consecutive audio being accumulated for one speaker. */
interface PendingRun {
  speaker?: string;
  chunks: Buffer[];
}

/**
 * Merges the transcription cache into segments, preserving speaker order.
 *
 * Consecutive audio blobs from one speaker become a single segment so that one
 * recognition request covers a whole utterance. A `Content` entry ends the run
 * that precedes it and is passed through. A blob with no data is skipped
 * without ending the run.
 *
 * A run with no role is bundled like any other. adk-python instead uses its
 * speaker as the pending-run flag, so role-less audio never flushes and its
 * own `speaker.lower() if speaker else 'user'` fallback cannot be reached.
 *
 * @param cache The entries to bundle, in cache order.
 * @return The segments, in cache order.
 */
function bundleTranscriptionCache(
  cache: TranscriptionEntry[],
): BundledSegment[] {
  const segments: BundledSegment[] = [];
  let pending: PendingRun | undefined;

  const flush = () => {
    if (pending === undefined) {
      return;
    }
    segments.push({
      kind: 'audio',
      speaker: pending.speaker,
      audio: Buffer.concat(pending.chunks),
    });
    pending = undefined;
  };

  for (const {role, data} of cache) {
    if (isContent(data)) {
      flush();
      segments.push({kind: 'content', content: data});
      continue;
    }

    if (!data.data) {
      continue;
    }

    // `Blob.data` is base64 in the JavaScript SDK, so the bytes have to be
    // decoded before they are joined: concatenating the encodings corrupts
    // the stream at the padding.
    const chunk = Buffer.from(data.data, 'base64');
    if (pending !== undefined && pending.speaker === role) {
      pending.chunks.push(chunk);
    } else {
      flush();
      pending = {speaker: role, chunks: [chunk]};
    }
  }

  flush();

  return segments;
}

/** Transcribes audio using Google Cloud Speech-to-Text. */
export class AudioTranscriber {
  private clientPromise?: Promise<SpeechClient>;

  /**
   * Resolves the Speech client, loading the `@google-cloud/speech` optional
   * peer on first use. Nothing calls this when the cache holds no audio, so an
   * application that only caches text never needs the package.
   */
  private getClient(): Promise<SpeechClient> {
    this.clientPromise ??= loadOptionalPeer(
      {packageName: '@google-cloud/speech', feature: 'AudioTranscriber'},
      () => import('@google-cloud/speech'),
    ).then(({SpeechClient: Client}) => new Client());
    return this.clientPromise;
  }

  /**
   * Transcribes the cached audio, bundling consecutive segments from the same
   * speaker.
   *
   * Speaker order is preserved. Audio blobs are merged per speaker as much as
   * possible to reduce transcription latency. The cache is emptied once it has
   * been bundled, before any recognition request runs, so a failed request
   * does not leave the audio to be transcribed twice.
   *
   * @param invocationContext The invocation context holding the cache.
   * @return The transcribed audio and the passed-through text, in cache order.
   */
  async transcribeFile(
    invocationContext: InvocationContext,
  ): Promise<Content[]> {
    const segments = bundleTranscriptionCache(
      invocationContext.transcriptionCache ?? [],
    );
    invocationContext.transcriptionCache = [];

    const contents: Content[] = [];
    for (const segment of segments) {
      if (segment.kind === 'content') {
        contents.push(segment.content);
        continue;
      }
      logger.debug(
        `Transcribing ${segment.audio.length} audio bytes for speaker ` +
          `${segment.speaker}.`,
      );
      const client = await this.getClient();
      // The cached blobs are required to be 16 kHz mono LINEAR16 PCM, so the
      // recognition config is fixed rather than configurable.
      const [response] = await client.recognize({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: 'en-US',
        },
        audio: {content: segment.audio},
      });
      for (const result of response.results ?? []) {
        const transcript = result.alternatives?.[0]?.transcript;
        if (transcript === undefined || transcript === null) {
          continue;
        }
        contents.push({
          role: segment.speaker ? segment.speaker.toLowerCase() : DEFAULT_ROLE,
          parts: [{text: transcript}],
        });
      }
    }
    return contents;
  }
}
