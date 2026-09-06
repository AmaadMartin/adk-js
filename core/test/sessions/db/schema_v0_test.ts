/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  StorageEventV0,
  storageEventV0ToEvent,
} from '../../../src/sessions/db/schema_v0.js';

function legacyRow(overrides: Partial<StorageEventV0> = {}): StorageEventV0 {
  return Object.assign(new StorageEventV0(), {
    id: 'e1',
    appName: 'app',
    userId: 'u1',
    sessionId: 's1',
    invocationId: 'inv-1',
    author: 'user',
    timestamp: new Date(1_700_000_000_000),
    ...overrides,
  });
}

describe('storageEventV0ToEvent', () => {
  it('maps the scalar columns', () => {
    const event = storageEventV0ToEvent(
      legacyRow({
        branch: 'agent_1.agent_2',
        partial: true,
        turnComplete: false,
        errorCode: 'SAFETY',
        errorMessage: 'blocked',
        interrupted: true,
      }),
    );

    expect(event.id).toBe('e1');
    expect(event.invocationId).toBe('inv-1');
    expect(event.author).toBe('user');
    expect(event.branch).toBe('agent_1.agent_2');
    expect(event.timestamp).toBe(1_700_000_000_000);
    expect(event.partial).toBe(true);
    expect(event.turnComplete).toBe(false);
    expect(event.errorCode).toBe('SAFETY');
    expect(event.errorMessage).toBe('blocked');
    expect(event.interrupted).toBe(true);
  });

  it('maps every optional JSON column', () => {
    const event = storageEventV0ToEvent(
      legacyRow({
        content: {role: 'user', parts: [{text: 'hello'}]},
        groundingMetadata: {web_search_queries: ['adk']},
        customMetadata: {trace_id: 'abc'},
        usageMetadata: {total_token_count: 12},
        citationMetadata: {citations: [{title: 'a doc'}]},
        inputTranscription: {text: 'spoken in'},
        outputTranscription: {text: 'spoken out'},
      }),
    );

    expect(event.content).toEqual({role: 'user', parts: [{text: 'hello'}]});
    expect(event.groundingMetadata).toEqual({webSearchQueries: ['adk']});
    expect(event.customMetadata).toEqual({trace_id: 'abc'});
    expect(event.usageMetadata).toEqual({totalTokenCount: 12});
    expect(event.citationMetadata).toEqual({citations: [{title: 'a doc'}]});
    expect(event.inputTranscription).toEqual({text: 'spoken in'});
    expect(event.outputTranscription).toEqual({text: 'spoken out'});
  });

  it('parses the long running tool ids out of their JSON column', () => {
    const event = storageEventV0ToEvent(
      legacyRow({longRunningToolIdsJson: JSON.stringify(['tool-1', 'tool-2'])}),
    );

    expect(event.longRunningToolIds).toEqual(['tool-1', 'tool-2']);
  });

  it('leaves the long running tool ids unset when the column is empty', () => {
    expect(
      storageEventV0ToEvent(legacyRow()).longRunningToolIds,
    ).toBeUndefined();
  });

  it('yields empty actions rather than decoding the pickle', () => {
    const event = storageEventV0ToEvent(
      legacyRow({actions: Buffer.from('\x80\x04\x95pickled', 'binary')}),
    );

    expect(event.actions).toEqual({
      stateDelta: {},
      artifactDelta: {},
      requestedAuthConfigs: {},
      requestedToolConfirmations: {},
    });
  });
});
