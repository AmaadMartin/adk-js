/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {SpeechClient} from '@google-cloud/speech';
import type {Blob, Content} from '@google/genai';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';
import type {InvocationContext} from './invocation_context.js';
import type {TranscriptionEntry} from './transcription_entry.js';

/**
 * Discriminates the `Blob | Content` union a cache entry carries.
 *
 * `Content` declares only `parts?` and `role?`, so testing for a `Blob` field
 * is total over the union. Testing for `parts` instead misreads a part-less
 * `{role: 'model'}` as audio, which drops it and merges the runs around it.
 *
 * @param data The entry payload to classify.
 * @return Whether the payload is a `Blob`.
 */
function isBlob(data: Blob | Content): data is Blob {
  return 'mimeType' in data || 'data' in data;
}

/**
 * One unit of work produced by bundling the transcription cache: either audio
 * that needs a recognition request, or content that is already text.
 */
type BundledSegment =
  | {kind: 'audio'; speaker: string; audio: Buffer}
  | {kind: 'content'; content: Content};

/**
 * Merges the transcription cache into segments, preserving speaker order.
 *
 * Consecutive audio blobs from one speaker become a single segment so that one
 * recognition request covers a whole utterance. A `Content` entry ends the run
 * that precedes it and is passed through. A blob with no data is skipped
 * without ending the run.
 *
 * A run carries its role lowercased, falling back to `user` when the entries
 * have none. adk-python instead uses the speaker as its pending-run flag, so
 * role-less audio never flushes and that fallback cannot be reached.
 *
 * @param cache The entries to bundle, in cache order.
 * @return The segments, in cache order.
 */
function bundleTranscriptionCache(
  cache: TranscriptionEntry[],
): BundledSegment[] {
  const segments: BundledSegment[] = [];
  let pending: {speaker?: string; chunks: Buffer[]} | undefined;

  const flush = () => {
    if (pending === undefined) {
      return;
    }
    segments.push({
      kind: 'audio',
      speaker: pending.speaker?.toLowerCase() || 'user',
      audio: Buffer.concat(pending.chunks),
    });
    pending = undefined;
  };

  for (const {role, data} of cache) {
    if (!isBlob(data)) {
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

/**
 * Transcribes audio using Google Cloud Speech-to-Text.
 *
 * Cached blobs must be 16 kHz mono LINEAR16 PCM, base64-encoded as
 * `@google/genai` represents `Blob.data`. The recognition config is fixed at
 * that format and `en-US`; `Blob.mimeType` is not read, so audio at another
 * sample rate transcribes incorrectly rather than failing.
 *
 * `@google-cloud/speech` is an optional peer dependency. It is loaded on the
 * first call that has audio, so a text-only cache never needs it installed.
 */
export class AudioTranscriber {
  private clientPromise?: Promise<SpeechClient>;

  /**
   * Resolves the Speech client, loading the `@google-cloud/speech` optional
   * peer on first use.
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
        if (transcript == null) {
          continue;
        }
        contents.push({role: segment.speaker, parts: [{text: transcript}]});
      }
    }
    return contents;
  }
}
