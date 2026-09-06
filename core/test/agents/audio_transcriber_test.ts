/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type protos} from '@google-cloud/speech';
import {
  AudioTranscriber,
  createSession,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import type {Content} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

type RecognizeRequest = protos.google.cloud.speech.v1.IRecognizeRequest;
type RecognizeResponse = protos.google.cloud.speech.v1.IRecognizeResponse;

const {SpeechClientMock, speech} = vi.hoisted(() => {
  interface RecordedCall {
    config: protos.google.cloud.speech.v1.IRecognitionConfig;
    audio: Buffer;
  }

  /** Shared state the tests script and inspect. */
  const speech = {
    /** One scripted response per `recognize` call, consumed in order. */
    responses: [] as RecognizeResponse[],
    /** Every `recognize` call, in order. */
    calls: [] as RecordedCall[],
    /** How many times the client was constructed. */
    constructions: 0,
    /** When set, the next `recognize` call rejects with it. */
    error: undefined as Error | undefined,
  };

  /** Recovers the bytes the caller sent, whatever shape they arrived in. */
  function toBuffer(content: string | Uint8Array | null | undefined): Buffer {
    if (content === null || content === undefined) {
      return Buffer.alloc(0);
    }
    return typeof content === 'string'
      ? Buffer.from(content, 'base64')
      : Buffer.from(content);
  }

  /** Stands in for `SpeechClient`, recording what it was asked to do. */
  class FakeSpeechClient {
    constructor() {
      speech.constructions++;
    }

    async recognize(request: RecognizeRequest): Promise<[RecognizeResponse]> {
      speech.calls.push({
        config: request.config ?? {},
        audio: toBuffer(request.audio?.content),
      });
      if (speech.error !== undefined) {
        throw speech.error;
      }
      const response = speech.responses.shift();
      if (response === undefined) {
        expect.fail('recognize was called more times than the test scripted');
      }
      return [response];
    }
  }

  return {SpeechClientMock: FakeSpeechClient, speech};
});

vi.mock('@google-cloud/speech', () => ({SpeechClient: SpeechClientMock}));

function textContent(role: string, text: string): Content {
  return {role, parts: [{text}]};
}

/** A response carrying one alternative per transcript. */
function scriptedResponse(...transcripts: string[]): RecognizeResponse {
  return {
    results: transcripts.map((transcript) => ({alternatives: [{transcript}]})),
  };
}

/** Builds a context whose transcription cache holds `cache`. */
function contextWithCache(
  cache: InvocationContext['transcriptionCache'],
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager([]),
    transcriptionCache: cache,
  });
}

/** An audio entry whose blob carries `bytes`, base64-encoded as the SDK does. */
function audioEntry(role: string | undefined, bytes: string) {
  return {
    role,
    data: {
      mimeType: 'audio/pcm',
      data: bytes === '' ? '' : Buffer.from(bytes).toString('base64'),
    },
  };
}

describe('AudioTranscriber', () => {
  beforeEach(() => {
    speech.responses = [];
    speech.calls = [];
    speech.constructions = 0;
    speech.error = undefined;
  });

  it('resets the transcription cache', async () => {
    const invocationContext = contextWithCache([
      {role: 'model', data: textContent('model', 'hello')},
    ]);

    await new AudioTranscriber().transcribeFile(invocationContext);

    expect(invocationContext.transcriptionCache).toEqual([]);
  });

  it('passes text content through in cache order', async () => {
    const first = textContent('user', 'first');
    const second = textContent('model', 'second');
    const third = textContent('user', 'third');
    const invocationContext = contextWithCache([
      {role: 'user', data: first},
      {role: 'model', data: second},
      {role: 'user', data: third},
    ]);

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(contents).toEqual([first, second, third]);
  });

  it('passes a Content with no parts through', async () => {
    const partLess: Content = {role: 'model'};
    const invocationContext = contextWithCache([
      {role: 'model', data: partLess},
    ]);

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(contents).toEqual([partLess]);
    expect(speech.calls).toEqual([]);
  });

  it('ends a run at a Content with no parts', async () => {
    const partLess: Content = {role: 'model'};
    speech.responses = [scriptedResponse('before'), scriptedResponse('after')];
    const invocationContext = contextWithCache([
      audioEntry('user', 'aa'),
      {role: 'model', data: partLess},
      audioEntry('user', 'bb'),
    ]);

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(speech.calls.map((call) => call.audio)).toEqual([
      Buffer.from('aa'),
      Buffer.from('bb'),
    ]);
    expect(contents).toEqual([
      textContent('user', 'before'),
      partLess,
      textContent('user', 'after'),
    ]);
  });

  it('skips a blob with no audio data without splitting the run', async () => {
    const text = textContent('model', 'hello');
    const invocationContext = contextWithCache([
      audioEntry('user', ''),
      {role: 'model', data: text},
    ]);

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(contents).toEqual([text]);
    expect(speech.calls).toEqual([]);
  });

  it('transcribes merged same-speaker audio', async () => {
    // adk-python marks the equivalent test xfail: it stores bundled audio as
    // raw bytes, so its `isinstance(data, Blob)` check never matches and the
    // audio is returned untranscribed. This port must transcribe it.
    const interleavedText = textContent('model', 'go on');
    const invocationContext = contextWithCache([
      audioEntry('user', 'aa'),
      audioEntry('user', 'bb'),
      {role: 'model', data: interleavedText},
      audioEntry('user', 'cc'),
    ]);
    speech.responses = [
      scriptedResponse('first half'),
      scriptedResponse('second half'),
    ];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    // Asserting on the decoded bytes is what catches a merge that concatenates
    // the base64 encodings instead of the bytes they encode.
    expect(speech.calls.map((call) => call.audio)).toEqual([
      Buffer.from('aabb'),
      Buffer.from('cc'),
    ]);
    expect(contents).toEqual([
      textContent('user', 'first half'),
      interleavedText,
      textContent('user', 'second half'),
    ]);
  });

  it('ends a run when the speaker changes', async () => {
    const invocationContext = contextWithCache([
      audioEntry('user', 'aa'),
      audioEntry('model', 'bb'),
    ]);
    speech.responses = [scriptedResponse('asked'), scriptedResponse('replied')];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(speech.calls.map((call) => call.audio)).toEqual([
      Buffer.from('aa'),
      Buffer.from('bb'),
    ]);
    expect(contents).toEqual([
      textContent('user', 'asked'),
      textContent('model', 'replied'),
    ]);
  });

  it('treats an undefined cache as empty and still empties it', async () => {
    const invocationContext = contextWithCache(undefined);

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(contents).toEqual([]);
    expect(invocationContext.transcriptionCache).toEqual([]);
  });

  it('sends the reference recognition config', async () => {
    const invocationContext = contextWithCache([audioEntry('user', 'aa')]);
    speech.responses = [scriptedResponse('hello')];

    await new AudioTranscriber().transcribeFile(invocationContext);

    expect(speech.calls.map((call) => call.config)).toEqual([
      {encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US'},
    ]);
  });

  it('constructs no Speech client for a text-only cache', async () => {
    const invocationContext = contextWithCache([
      {role: 'model', data: textContent('model', 'hello')},
    ]);

    await new AudioTranscriber().transcribeFile(invocationContext);

    expect(speech.constructions).toBe(0);
  });

  it('lower-cases the speaker role', async () => {
    const invocationContext = contextWithCache([audioEntry('USER', 'aa')]);
    speech.responses = [scriptedResponse('hello')];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(contents).toEqual([textContent('user', 'hello')]);
  });

  it('emits one Content per recognition result', async () => {
    const invocationContext = contextWithCache([audioEntry('user', 'aa')]);
    speech.responses = [scriptedResponse('first', 'second')];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(contents).toEqual([
      textContent('user', 'first'),
      textContent('user', 'second'),
    ]);
  });

  it('skips a result that carries no transcript', async () => {
    // The generated protos make `alternatives` and `transcript` optional, so
    // a result can arrive with neither. Emitting `{text: undefined}` would put
    // an empty part into the session history.
    const invocationContext = contextWithCache([audioEntry('user', 'aa')]);
    speech.responses = [
      {
        results: [
          {},
          {alternatives: []},
          {alternatives: [{}]},
          {alternatives: [{transcript: null}]},
          {alternatives: [{transcript: 'kept'}]},
        ],
      },
    ];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(contents).toEqual([textContent('user', 'kept')]);
  });

  it('contributes nothing for a response with no results', async () => {
    const invocationContext = contextWithCache([audioEntry('user', 'aa')]);
    speech.responses = [{}];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(contents).toEqual([]);
    expect(speech.calls).toHaveLength(1);
  });

  it("defaults a role-less run to 'user'", async () => {
    const invocationContext = contextWithCache([audioEntry(undefined, 'aa')]);
    speech.responses = [scriptedResponse('hello')];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(speech.calls.map((call) => call.audio)).toEqual([Buffer.from('aa')]);
    expect(contents).toEqual([textContent('user', 'hello')]);
  });

  it("merges consecutive role-less audio into one 'user' run", async () => {
    const invocationContext = contextWithCache([
      audioEntry(undefined, 'aa'),
      audioEntry(undefined, 'bb'),
    ]);
    speech.responses = [scriptedResponse('hello')];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(speech.calls.map((call) => call.audio)).toEqual([
      Buffer.from('aabb'),
    ]);
    expect(contents).toEqual([textContent('user', 'hello')]);
  });

  it("keeps a role-less run separate from the next speaker's run", async () => {
    const invocationContext = contextWithCache([
      audioEntry(undefined, 'aa'),
      audioEntry('model', 'bb'),
    ]);
    speech.responses = [scriptedResponse('asked'), scriptedResponse('replied')];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(speech.calls.map((call) => call.audio)).toEqual([
      Buffer.from('aa'),
      Buffer.from('bb'),
    ]);
    expect(contents).toEqual([
      textContent('user', 'asked'),
      textContent('model', 'replied'),
    ]);
  });

  it("defaults an empty-string role to 'user'", async () => {
    // adk-python's fallback is truthiness-based, so '' takes it too.
    const invocationContext = contextWithCache([audioEntry('', 'aa')]);
    speech.responses = [scriptedResponse('hello')];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(contents).toEqual([textContent('user', 'hello')]);
  });

  it('ends a role-less run at an interleaved Content', async () => {
    const interleavedText = textContent('model', 'go on');
    const invocationContext = contextWithCache([
      audioEntry(undefined, 'aa'),
      {role: 'model', data: interleavedText},
      audioEntry(undefined, 'bb'),
    ]);
    speech.responses = [
      scriptedResponse('first half'),
      scriptedResponse('second half'),
    ];

    const contents = await new AudioTranscriber().transcribeFile(
      invocationContext,
    );

    expect(speech.calls.map((call) => call.audio)).toEqual([
      Buffer.from('aa'),
      Buffer.from('bb'),
    ]);
    expect(contents).toEqual([
      textContent('user', 'first half'),
      interleavedText,
      textContent('user', 'second half'),
    ]);
  });

  it('reuses one client across calls', async () => {
    const transcriber = new AudioTranscriber();
    speech.responses = [scriptedResponse('one'), scriptedResponse('two')];

    await transcriber.transcribeFile(
      contextWithCache([audioEntry('user', 'a')]),
    );
    await transcriber.transcribeFile(
      contextWithCache([audioEntry('user', 'b')]),
    );

    expect(speech.constructions).toBe(1);
  });

  it('propagates a Speech API failure and still empties the cache', async () => {
    const invocationContext = contextWithCache([audioEntry('user', 'aa')]);
    speech.error = new Error('UNAVAILABLE');

    await expect(
      new AudioTranscriber().transcribeFile(invocationContext),
    ).rejects.toThrow('UNAVAILABLE');
    expect(invocationContext.transcriptionCache).toEqual([]);
  });
});
