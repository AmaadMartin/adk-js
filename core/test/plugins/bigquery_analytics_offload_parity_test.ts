/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports of the Cloud Storage offload and external-URI tests from
 * `google/adk-python`, kept under their Python names so a reviewer can grep
 * one repository from the other.
 *
 * Source: `tests/unittests/plugins/test_bigquery_agent_analytics_plugin.py`
 * at `google/adk-python` `main`, commit `c7ffcfa8`. The names come from
 * `TestOffloadUnitSeparation` and from the offload tests elsewhere in that
 * file.
 */

import type {TableMetadata} from '@google-cloud/bigquery';
import type {SaveOptions} from '@google-cloud/storage';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {BigQueryAgentAnalyticsPlugin} from '../../src/plugins/bigquery_agent_analytics_plugin.js';
import type {BigQueryLoggerConfig} from '../../src/plugins/bigquery_analytics_config.js';
import {
  AnalyticsOffload,
  parseAnalyticsContent,
  parseContentParts,
} from '../../src/plugins/bigquery_analytics_content.js';
import {
  ContentOffloader,
  GcsOffloader,
  OffloadBucket,
  OffloadStorage,
} from '../../src/plugins/bigquery_analytics_offloader.js';
import type {AnalyticsRow} from '../../src/plugins/bigquery_analytics_schema.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';

/** One recorded `file(...).save(...)` call. */
interface SavedObject {
  path: string;
  data: Buffer | string;
  options: SaveOptions;
}

const {BigQueryMock, StorageMock, inserted, saved} = vi.hoisted(() => {
  const inserted: AnalyticsRow[] = [];
  const saved: Array<{path: string; data: unknown; options: unknown}> = [];

  class FakeTable {
    async exists(): Promise<[boolean]> {
      return [true];
    }

    async getMetadata(): Promise<[TableMetadata]> {
      return [{schema: {fields: []}, labels: {adk_schema_version: '2'}}];
    }

    async setMetadata(metadata: TableMetadata): Promise<[TableMetadata]> {
      return [metadata];
    }

    async insert(rows: Array<{json: AnalyticsRow}>): Promise<void> {
      for (const row of rows) {
        inserted.push(row.json);
      }
    }
  }

  class FakeDataset {
    async exists(): Promise<[boolean]> {
      return [true];
    }

    table(): FakeTable {
      return new FakeTable();
    }
  }

  class BigQueryMock {
    dataset(): FakeDataset {
      return new FakeDataset();
    }

    async query(): Promise<[unknown[]]> {
      return [[]];
    }
  }

  class StorageMock {
    bucket(name: string) {
      return {
        file: (path: string) => ({
          save: async (data: unknown, options: unknown) => {
            saved.push({path: `${name}/${path}`, data, options});
          },
        }),
      };
    }
  }

  return {BigQueryMock, StorageMock, inserted, saved};
});

vi.mock('@google-cloud/bigquery', () => ({BigQuery: BigQueryMock}));
vi.mock('@google-cloud/storage', () => ({Storage: StorageMock}));

const PROJECT_ID = 'test-project';
const DATASET_ID = 'agent_analytics';

/** Records every upload and answers with a predictable URI. */
class FakeOffloader implements ContentOffloader {
  readonly uploaded: string[] = [];
  readonly data: Array<Buffer | string> = [];

  constructor(private readonly settle: () => Promise<void> = async () => {}) {}

  async uploadContent(
    data: Buffer | string,
    _contentType: string,
    path: string,
  ): Promise<string> {
    this.uploaded.push(path);
    this.data.push(data);
    await this.settle();
    return `gs://bucket/${path}`;
  }
}

/** The offload context a parser-level test writes through. */
function offloadTo(
  offloader: ContentOffloader,
  traceId = 't',
  spanId = 's',
): AnalyticsOffload {
  return {offloader, traceId, spanId};
}

function makePlugin(
  config: BigQueryLoggerConfig,
): BigQueryAgentAnalyticsPlugin {
  return new BigQueryAgentAnalyticsPlugin({
    projectId: PROJECT_ID,
    datasetId: DATASET_ID,
    config,
  });
}

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'agent', model: 'gemini-2.0-flash'}),
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'user-1',
    }),
    pluginManager: new PluginManager([]),
  });
}

function makeContext(invocationContext: InvocationContext): Context {
  return new Context({invocationContext});
}

function makeLlmRequest(overrides: Partial<LlmRequest>): LlmRequest {
  return {
    model: 'gemini-pro',
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

/** The single row the plugin wrote. */
function onlyRow(): AnalyticsRow {
  expect(inserted).toHaveLength(1);
  return inserted[0];
}

describe('adk-python TestOffloadUnitSeparation', () => {
  it('test_multibyte_text_offloaded_by_byte_limit', async () => {
    const offloader = new FakeOffloader();
    const text = '\u{1F600}'.repeat(10000);
    expect([...text]).toHaveLength(10000);
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(32 * 1024);

    const parsed = await parseContentParts(
      {parts: [{text}]},
      {maxLength: -1, offload: offloadTo(offloader)},
    );

    expect(offloader.uploaded).toHaveLength(1);
    expect(parsed.parts[0].storage_mode).toBe('GCS_REFERENCE');
  });

  it('test_ascii_under_both_limits_stays_inline', async () => {
    const offloader = new FakeOffloader();
    const text = 'A'.repeat(1000);

    const parsed = await parseContentParts(
      {parts: [{text}]},
      {maxLength: 50000, offload: offloadTo(offloader)},
    );

    expect(offloader.uploaded).toEqual([]);
    expect(parsed.parts[0].storage_mode).toBe('INLINE');
    expect(parsed.parts[0].text).toBe(text);
  });

  it('test_text_exceeding_char_limit_offloaded', async () => {
    const offloader = new FakeOffloader();
    const text = 'X'.repeat(200);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(32 * 1024);

    const parsed = await parseContentParts(
      {parts: [{text}]},
      {maxLength: 100, offload: offloadTo(offloader)},
    );

    expect(offloader.uploaded).toHaveLength(1);
    expect(parsed.parts[0].storage_mode).toBe('GCS_REFERENCE');
  });

  it('test_multibyte_under_char_and_byte_limits_stays_inline', async () => {
    const offloader = new FakeOffloader();
    const text = '\u{1F600}'.repeat(3000);
    expect(text.length).toBeLessThan(10000);
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(10000);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(32 * 1024);

    const parsed = await parseContentParts(
      {parts: [{text}]},
      {maxLength: 10000, offload: offloadTo(offloader)},
    );

    expect(offloader.uploaded).toEqual([]);
    expect(parsed.parts[0].storage_mode).toBe('INLINE');
  });

  it('test_list_content_is_unpacked_into_parts', async () => {
    const parsed = await parseContentParts([{text: 'hi'}, {text: 'there'}], {
      maxLength: 50000,
    });

    expect(parsed.summary).toBe('hi | there');
    expect(parsed.truncated).toBe(false);
    expect(parsed.parts.map((part) => part.text)).toEqual(['hi', 'there']);
    expect(parsed.parts[0].storage_mode).toBe('INLINE');
  });

  it('test_non_content_union_member_does_not_raise', async () => {
    const parsed = await parseContentParts({name: 'f'}, {maxLength: 50000});

    expect(parsed.summary).toBe('');
    expect(parsed.truncated).toBe(false);
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0].text).toBeNull();
    expect(parsed.parts[0].storage_mode).toBe('INLINE');
  });

  it('test_no_offloader_falls_back_to_truncate', async () => {
    const parsed = await parseContentParts(
      {parts: [{text: 'Z'.repeat(200)}]},
      {maxLength: 50},
    );

    expect(parsed.truncated).toBe(true);
    expect(parsed.parts[0].storage_mode).toBe('INLINE');
    expect(parsed.parts[0].text).toContain('TRUNCATED');
  });

  it('test_raw_prompt_text_is_sanitized_inline', async () => {
    const secret = 'INLINE-CONTENT-SECRET';
    const request = makeLlmRequest({
      contents: [
        {
          role: JSON.stringify({authorization: secret}),
          parts: [{text: JSON.stringify({secret})}],
        },
      ],
      config: {systemInstruction: JSON.stringify({private_key: secret})},
    });

    const parsed = await parseAnalyticsContent(request, -1);

    const stored = JSON.stringify({
      content: parsed.payload,
      content_parts: parsed.parts,
    });
    expect(stored).not.toContain(secret);
    expect(stored.split('[REDACTED]').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('test_raw_prompt_text_is_redacted_at_row_boundary', async () => {
    const secret = 'ROW-BOUNDARY-CONTENT-SECRET';
    const plugin = makePlugin({});
    await plugin.beforeModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmRequest: makeLlmRequest({
        contents: [
          {
            role: 'user',
            parts: [{text: JSON.stringify({access_token: secret})}],
          },
        ],
      }),
    });
    await plugin.flush();

    const stored = JSON.stringify(onlyRow());
    expect(stored).not.toContain(secret);
    expect(stored).toContain('[REDACTED]');
  });

  it('test_gcs_text_upload_receives_only_sanitized_content', async () => {
    const offloader = new FakeOffloader();
    const secret = 'GCS-CONTENT-SECRET';
    const text = JSON.stringify({
      token: secret,
      padding: 'x'.repeat(33 * 1024),
    });

    const parsed = await parseAnalyticsContent(
      {parts: [{text}]},
      -1,
      offloadTo(offloader),
    );

    const uploaded = offloader.data[0];
    expect(uploaded).not.toContain(secret);
    expect(uploaded).toContain('[REDACTED]');
    const stored = JSON.stringify({
      content: parsed.payload,
      content_parts: parsed.parts,
    });
    expect(stored).not.toContain(secret);
    expect(stored).toContain('[REDACTED]');
  });

  it('test_internal_formatter_sentinel_is_preserved', async () => {
    const parsed = await parseAnalyticsContent('[FORMATTER_FAILED]', -1);
    expect(parsed.payload).toBe('[FORMATTER_FAILED]');
  });
});

describe('adk-python offload object names', () => {
  it('test_concurrent_parses_never_share_gcs_paths', async () => {
    const offloader = new FakeOffloader(
      // Force an interleave between the two parses' part uploads.
      async () => new Promise<void>((resolve) => setImmediate(resolve)),
    );
    const twoParts = () => ({
      parts: [
        {inlineData: {data: 'eA==', mimeType: 'image/png'}},
        {inlineData: {data: 'eQ==', mimeType: 'image/png'}},
      ],
    });

    await Promise.all([
      parseAnalyticsContent(
        twoParts(),
        -1,
        offloadTo(offloader, 'trace-a', 'span-a'),
      ),
      parseAnalyticsContent(
        twoParts(),
        -1,
        offloadTo(offloader, 'trace-b', 'span-b'),
      ),
    ]);

    expect(offloader.uploaded).toHaveLength(4);
    expect(new Set(offloader.uploaded).size).toBe(4);
    expect(
      offloader.uploaded.filter((path) => path.includes('trace-a/span-a')),
    ).toHaveLength(2);
    expect(
      offloader.uploaded.filter((path) => path.includes('trace-b/span-b')),
    ).toHaveLength(2);
  });

  it('test_multi_message_offloads_get_unique_paths', async () => {
    const offloader = new FakeOffloader();
    const request = makeLlmRequest({
      contents: [
        {
          role: 'user',
          parts: [{inlineData: {data: 'YQ==', mimeType: 'image/png'}}],
        },
        {
          role: 'user',
          parts: [{inlineData: {data: 'Yg==', mimeType: 'image/png'}}],
        },
      ],
    });

    await parseAnalyticsContent(
      request,
      -1,
      offloadTo(offloader, 'trace-x', 'span-x'),
    );

    expect(offloader.uploaded).toHaveLength(2);
    expect(new Set(offloader.uploaded).size).toBe(2);
  });

  it('test_gcs_uploads_use_full_uid_and_create_only', async () => {
    const offloader = new FakeOffloader();
    await parseAnalyticsContent(
      {parts: [{inlineData: {data: 'YQ==', mimeType: 'image/png'}}]},
      -1,
      offloadTo(offloader, 'trace-y', 'span-y'),
    );

    expect(offloader.uploaded).toHaveLength(1);
    const uid = offloader.uploaded[0].split('span-y_')[1].split('_c')[0];
    expect(uid).toHaveLength(32);

    // And the upload path passes create-only semantics.
    const objects: SavedObject[] = [];
    const storage: OffloadStorage = {
      bucket: (): OffloadBucket => ({
        file: (path: string) => ({
          save: async (data: Buffer | string, options: SaveOptions) => {
            objects.push({path, data, options});
          },
        }),
      }),
    };
    await new GcsOffloader({
      projectId: PROJECT_ID,
      bucketName: 'b',
      storage,
    }).uploadContent(Buffer.from('data'), 'image/png', 'p');
    expect(objects[0].options.preconditionOpts).toEqual({ifGenerationMatch: 0});
  });
});

describe('adk-python external URI redaction', () => {
  it('test_raw_bracket_prose_preserved_inline_and_gcs', async () => {
    for (const value of [
      '[INFO] ready',
      '[link](https://example.test)',
      '{not json}',
    ]) {
      const parsed = await parseAnalyticsContent({parts: [{text: value}]}, -1);
      expect(parsed.payload).toEqual({text_summary: value});
      expect(parsed.parts[0].text).toBe(value);
      expect(parsed.truncated).toBe(false);
    }

    const offloader = new FakeOffloader();
    const largeProse = `[INFO] ${'safe prose '.repeat(4000)}`;
    await parseAnalyticsContent(
      {parts: [{text: largeProse}]},
      -1,
      offloadTo(offloader),
    );
    expect(offloader.data[0]).toBe(largeProse);
  });

  it('test_external_uri_redacts_query_fragment_and_userinfo', async () => {
    const signed =
      'https://storage.example.test/safe/path?safe=kept' +
      '&X-Goog-Credential=URI-CREDENTIAL' +
      '&X-Goog-Signature=URI-SIGNATURE#access-token=FRAGMENT-SECRET';

    const signedParse = await parseAnalyticsContent(
      {parts: [{fileData: {fileUri: signed, mimeType: 'text/plain'}}]},
      -1,
    );

    const uri = signedParse.parts[0].uri ?? '';
    expect(uri.startsWith('https://storage.example.test/safe/path?')).toBe(
      true,
    );
    expect(uri).toContain('safe=kept');
    for (const secret of [
      'URI-CREDENTIAL',
      'URI-SIGNATURE',
      'FRAGMENT-SECRET',
    ]) {
      expect(uri).not.toContain(secret);
    }
    expect(signedParse.truncated).toBe(true);

    const userinfoParse = await parseAnalyticsContent(
      {
        parts: [
          {
            fileData: {
              fileUri: 'https://user:password@example.test/safe',
              mimeType: 'text/plain',
            },
          },
        ],
      },
      -1,
    );
    expect(userinfoParse.parts[0].uri).toBe('[REDACTED_SENSITIVE_URI]');
    expect(userinfoParse.truncated).toBe(true);
  });

  it('test_external_uri_redacts_sensitive_path_segments_and_variants', async () => {
    const uri =
      'https://example.test/public/access-token/PATH-SECRET/report' +
      '?x-amz-signature=QUERY-SIGNATURE-SECRET' +
      '&access%255Ftoken%253DDOUBLE-QUERY-SECRET';

    const sensitiveParse = await parseAnalyticsContent(
      {parts: [{fileData: {fileUri: uri, mimeType: 'text/plain'}}]},
      -1,
    );

    const storedUri = sensitiveParse.parts[0].uri ?? '';
    for (const secret of [
      'PATH-SECRET',
      'QUERY-SIGNATURE-SECRET',
      'DOUBLE-QUERY-SECRET',
    ]) {
      expect(storedUri).not.toContain(secret);
    }
    expect(storedUri).toContain('/public/%5BREDACTED%5D/%5BREDACTED%5D/report');
    expect(sensitiveParse.truncated).toBe(true);

    const safeUri =
      'https://example.test/design/signal/public/progress%25/report';
    const safeParse = await parseAnalyticsContent(
      {parts: [{fileData: {fileUri: safeUri, mimeType: 'text/plain'}}]},
      -1,
    );
    expect(safeParse.parts[0].uri).toBe(safeUri);
    expect(safeParse.truncated).toBe(false);

    const missingParse = await parseAnalyticsContent(
      {parts: [{fileData: {mimeType: 'text/plain'}}]},
      -1,
    );
    expect(missingParse.parts[0].uri).toBe('[REDACTED_SENSITIVE_URI]');
    expect(missingParse.truncated).toBe(true);
  });
});

describe('adk-python plugin-level offload', () => {
  beforeEach(() => {
    inserted.length = 0;
    saved.length = 0;
  });

  it('test_offloading_with_connection_id', async () => {
    const plugin = makePlugin({
      gcsBucketName: 'my-bucket',
      connectionId: 'us.my-connection',
      maxContentLength: 20,
    });
    const smallText = 'Small inline text';

    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: {
        role: 'user',
        parts: [{text: smallText}, {text: 'A'.repeat(100)}],
      },
    });
    await plugin.flush();

    const parts = onlyRow().content_parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      storage_mode: 'INLINE',
      text: smallText,
      object_ref: null,
    });
    expect(parts[1].storage_mode).toBe('GCS_REFERENCE');
    expect(parts[1].uri?.startsWith('gs://my-bucket/')).toBe(true);
    expect(parts[1].object_ref?.uri).toBe(parts[1].uri);
    expect(parts[1].object_ref?.authorizer).toBe('us.my-connection');
    expect(JSON.parse(parts[1].object_ref?.details ?? '{}')).toEqual({
      gcs_metadata: {content_type: 'text/plain'},
    });
  });

  it('test_multimodal_offloading', async () => {
    const bucketName = 'test-bucket';
    const plugin = makePlugin({gcsBucketName: bucketName});
    const largeText = 'A'.repeat(32 * 1024 + 1);

    await plugin.beforeModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmRequest: makeLlmRequest({contents: [{parts: [{text: largeText}]}]}),
    });
    await plugin.flush();

    expect(saved).toHaveLength(1);
    expect(saved[0].data).toBe(largeText);
    expect(saved[0].options).toMatchObject({contentType: 'text/plain'});
    const parts = onlyRow().content_parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].storage_mode).toBe('GCS_REFERENCE');
    expect(parts[0].uri?.startsWith(`gs://${bucketName}/`)).toBe(true);
  });

  it('test_content_parts_denied_disables_gcs_offload', async () => {
    const plugin = makePlugin({
      gcsBucketName: 'test-bucket',
      payloadColumnDenylist: ['content_parts'],
    });

    await plugin.beforeModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmRequest: makeLlmRequest({
        contents: [{parts: [{text: 'A'.repeat(32 * 1024 + 1)}]}],
      }),
    });
    await plugin.flush();

    expect(saved).toEqual([]);
  });

  it('test_both_payload_columns_denied_skips_parse_and_offload', async () => {
    const plugin = makePlugin({
      gcsBucketName: 'test-bucket',
      payloadColumnDenylist: ['content', 'content_parts'],
    });

    await plugin.beforeModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmRequest: makeLlmRequest({
        contents: [{parts: [{text: 'A'.repeat(32 * 1024 + 1)}]}],
      }),
    });
    await plugin.flush();

    expect(saved).toEqual([]);
  });
});
