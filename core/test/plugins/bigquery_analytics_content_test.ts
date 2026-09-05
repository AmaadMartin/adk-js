/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  AnalyticsOffload,
  parseAnalyticsContent,
  parseContentParts,
} from '../../src/plugins/bigquery_analytics_content.js';
import type {ContentOffloader} from '../../src/plugins/bigquery_analytics_offloader.js';

/** One recorded upload. */
interface Upload {
  data: Buffer | string;
  contentType: string;
  path: string;
}

/** Records every upload and answers with a predictable URI. */
class RecordingOffloader implements ContentOffloader {
  readonly uploads: Upload[] = [];

  constructor(private readonly failure?: Error) {}

  async uploadContent(
    data: Buffer | string,
    contentType: string,
    path: string,
  ): Promise<string> {
    this.uploads.push({data, contentType, path});
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return `gs://bucket/${path}`;
  }
}

/** The offload context one test writes through. */
function offloadTo(
  offloader: ContentOffloader,
  connectionId?: string,
): AnalyticsOffload {
  return {offloader, traceId: 'trace-1', spanId: 'span-1', connectionId};
}

describe('parseContentParts binary offload', () => {
  it('writes [BINARY DATA] when no bucket is configured', async () => {
    const parsed = await parseContentParts(
      {parts: [{inlineData: {data: 'AAAA', mimeType: 'image/png'}}]},
      {maxLength: -1},
    );
    expect(parsed.parts[0]).toMatchObject({
      text: '[BINARY DATA]',
      storage_mode: 'INLINE',
      uri: null,
      object_ref: null,
    });
  });

  it('uploads the decoded bytes and records the object reference', async () => {
    const offloader = new RecordingOffloader();
    const parsed = await parseContentParts(
      {parts: [{inlineData: {data: 'aGk=', mimeType: 'image/png'}}]},
      {maxLength: -1, offload: offloadTo(offloader, 'us.my-connection')},
    );

    expect(offloader.uploads[0].data).toEqual(Buffer.from('hi'));
    expect(offloader.uploads[0].contentType).toBe('image/png');
    const uri = `gs://bucket/${offloader.uploads[0].path}`;
    expect(parsed.parts[0]).toMatchObject({
      storage_mode: 'GCS_REFERENCE',
      mime_type: 'image/png',
      text: '[MEDIA OFFLOADED]',
      uri,
    });
    expect(parsed.parts[0].object_ref).toEqual({
      uri,
      version: null,
      authorizer: 'us.my-connection',
      details: '{"gcs_metadata":{"content_type":"image/png"}}',
    });
  });

  it('records a null authorizer when no connection is configured', async () => {
    const offloader = new RecordingOffloader();
    const parsed = await parseContentParts(
      {parts: [{inlineData: {data: 'AAAA', mimeType: 'image/png'}}]},
      {maxLength: -1, offload: offloadTo(offloader)},
    );
    expect(parsed.parts[0].object_ref?.authorizer).toBeNull();
  });

  it('falls back to the octet-stream type and the .bin extension', async () => {
    const offloader = new RecordingOffloader();
    const parsed = await parseContentParts(
      {parts: [{inlineData: {data: 'AAAA'}}]},
      {maxLength: -1, offload: offloadTo(offloader)},
    );
    expect(offloader.uploads[0].contentType).toBe('application/octet-stream');
    expect(offloader.uploads[0].path).toMatch(/\.bin$/);
    expect(parsed.parts[0].mime_type).toBe('application/octet-stream');
  });

  it('uploads an empty object for inline data carrying no bytes', async () => {
    const offloader = new RecordingOffloader();
    await parseContentParts(
      {parts: [{inlineData: {mimeType: 'image/png'}}]},
      {maxLength: -1, offload: offloadTo(offloader)},
    );
    expect(offloader.uploads[0].data).toEqual(Buffer.alloc(0));
  });

  it('uses the .bin extension for an unrecognized MIME type', async () => {
    const offloader = new RecordingOffloader();
    await parseContentParts(
      {parts: [{inlineData: {data: 'AAAA', mimeType: 'model/gltf-binary'}}]},
      {maxLength: -1, offload: offloadTo(offloader)},
    );
    expect(offloader.uploads[0].path).toMatch(/\.bin$/);
  });

  it('writes [UPLOAD FAILED] and keeps the row when the upload throws', async () => {
    const offloader = new RecordingOffloader(new Error('precondition failed'));
    const parsed = await parseContentParts(
      {parts: [{inlineData: {data: 'AAAA', mimeType: 'image/png'}}]},
      {maxLength: -1, offload: offloadTo(offloader)},
    );
    expect(parsed.parts[0]).toMatchObject({
      text: '[UPLOAD FAILED]',
      storage_mode: 'INLINE',
      uri: null,
      object_ref: null,
    });
  });
});

describe('parseContentParts text offload', () => {
  it('offloads the sanitized text and keeps a preview', async () => {
    const offloader = new RecordingOffloader();
    const text = 'B'.repeat(32 * 1024 + 1);
    const parsed = await parseContentParts(
      {parts: [{text}]},
      {maxLength: -1, offload: offloadTo(offloader, 'us.conn')},
    );

    expect(offloader.uploads[0].contentType).toBe('text/plain');
    expect(offloader.uploads[0].path).toMatch(/\.txt$/);
    expect(parsed.parts[0].text).toBe(`${'B'.repeat(200)}... [OFFLOADED]`);
    expect(parsed.parts[0].object_ref).toMatchObject({
      authorizer: 'us.conn',
      details: '{"gcs_metadata":{"content_type":"text/plain"}}',
    });
  });

  it('keeps an offloaded part out of the content summary', async () => {
    const offloader = new RecordingOffloader();
    const parsed = await parseContentParts(
      {parts: [{text: 'small'}, {text: 'C'.repeat(32 * 1024 + 1)}]},
      {maxLength: -1, offload: offloadTo(offloader)},
    );
    expect(parsed.summary).toBe('small');
  });

  it('falls back to inline truncated text when the upload throws', async () => {
    const offloader = new RecordingOffloader(new Error('bucket missing'));
    const parsed = await parseContentParts(
      {parts: [{text: 'D'.repeat(300)}]},
      {maxLength: 100, offload: offloadTo(offloader)},
    );
    expect(parsed.parts[0]).toMatchObject({
      storage_mode: 'INLINE',
      uri: null,
      object_ref: null,
    });
    expect(parsed.parts[0].text).toBe(`${'D'.repeat(100)}...[TRUNCATED]`);
    expect(parsed.summary).toBe(`${'D'.repeat(100)}...[TRUNCATED]`);
    expect(parsed.truncated).toBe(true);
  });
});

describe('parseContentParts object names', () => {
  it('names an object by date, trace, span, parse and part', async () => {
    const offloader = new RecordingOffloader();
    await parseContentParts(
      {
        parts: [
          {inlineData: {data: 'AAAA', mimeType: 'image/png'}},
          {inlineData: {data: 'AAAA', mimeType: 'image/jpeg'}},
        ],
      },
      {
        maxLength: -1,
        offload: offloadTo(offloader),
        parseUid: 'f'.repeat(32),
        contentOrdinal: 3,
      },
    );
    const date = new Date();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    const prefix = `${date.getFullYear()}-${month}-${day}/trace-1/span-1_${'f'.repeat(32)}_c3`;
    expect(offloader.uploads.map((upload) => upload.path)).toEqual([
      `${prefix}_p0.png`,
      `${prefix}_p1.jpg`,
    ]);
  });
});

describe('parseContentParts unpacking', () => {
  it('gives a list member that is not an object an empty record', async () => {
    const parsed = await parseContentParts(['bare string', {text: 'kept'}], {
      maxLength: -1,
    });
    expect(parsed.parts).toHaveLength(2);
    expect(parsed.parts[0].text).toBeNull();
    expect(parsed.parts[1].text).toBe('kept');
    expect(parsed.summary).toBe('kept');
  });
});

describe('parseAnalyticsContent offload', () => {
  it('shares one parse identifier across the messages of a request', async () => {
    const offloader = new RecordingOffloader();
    await parseAnalyticsContent(
      {
        contents: [
          {
            role: 'user',
            parts: [{inlineData: {data: 'AA', mimeType: 'image/png'}}],
          },
          {
            role: 'user',
            parts: [{inlineData: {data: 'BB', mimeType: 'image/png'}}],
          },
        ],
        toolsDict: {},
      },
      -1,
      offloadTo(offloader),
    );
    const uids = offloader.uploads.map(
      (upload) => upload.path.split('span-1_')[1].split('_c')[0],
    );
    expect(uids[0]).toBe(uids[1]);
    expect(offloader.uploads[0].path).toContain('_c0_p0');
    expect(offloader.uploads[1].path).toContain('_c1_p0');
  });

  it('offloads nothing when no destination is supplied', async () => {
    const parsed = await parseAnalyticsContent(
      {role: 'user', parts: [{text: 'E'.repeat(32 * 1024 + 1)}]},
      -1,
    );
    expect(parsed.parts[0].storage_mode).toBe('INLINE');
    expect(parsed.parts[0].text).toBe('E'.repeat(32 * 1024 + 1));
  });
});
