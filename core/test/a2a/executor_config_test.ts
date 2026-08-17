/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  A2APartToGenAIPartConverter,
  A2ARequestToAgentRunRequestConverter,
  AdkEventToA2AEventConverter,
  GenAIPartToA2APartConverter,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {toA2AArtifactUpdateEvent} from '../../src/a2a/event_converter_utils.js';
import {resolveConverters} from '../../src/a2a/executor_config.js';
import {toA2APart, toGenAIPart} from '../../src/a2a/part_converter_utils.js';
import {toAgentRunRequest} from '../../src/a2a/request_converter_utils.js';

describe('resolveConverters', () => {
  it('fills every slot with its built-in converter', () => {
    expect(resolveConverters({})).toEqual({
      a2aPartConverter: toGenAIPart,
      genAIPartConverter: toA2APart,
      requestConverter: toAgentRunRequest,
      eventConverter: toA2AArtifactUpdateEvent,
    });
  });

  it('keeps a supplied a2aPartConverter and defaults the other slots', () => {
    const a2aPartConverter: A2APartToGenAIPartConverter = () => ({
      text: 'custom',
    });

    expect(resolveConverters({a2aPartConverter})).toEqual({
      a2aPartConverter,
      genAIPartConverter: toA2APart,
      requestConverter: toAgentRunRequest,
      eventConverter: toA2AArtifactUpdateEvent,
    });
  });

  it('keeps a supplied genAIPartConverter and defaults the other slots', () => {
    const genAIPartConverter: GenAIPartToA2APartConverter = () => ({
      kind: 'text',
      text: 'custom',
    });

    expect(resolveConverters({genAIPartConverter})).toEqual({
      a2aPartConverter: toGenAIPart,
      genAIPartConverter,
      requestConverter: toAgentRunRequest,
      eventConverter: toA2AArtifactUpdateEvent,
    });
  });

  it('keeps a supplied requestConverter and defaults the other slots', () => {
    const requestConverter: A2ARequestToAgentRunRequestConverter = () => ({
      userId: 'custom-user',
      sessionId: 'custom-session',
      newMessage: {role: 'user', parts: [{text: 'custom'}]},
    });

    expect(resolveConverters({requestConverter})).toEqual({
      a2aPartConverter: toGenAIPart,
      genAIPartConverter: toA2APart,
      requestConverter,
      eventConverter: toA2AArtifactUpdateEvent,
    });
  });

  it('keeps a supplied eventConverter and defaults the other slots', () => {
    const eventConverter: AdkEventToA2AEventConverter = () => undefined;

    expect(resolveConverters({eventConverter})).toEqual({
      a2aPartConverter: toGenAIPart,
      genAIPartConverter: toA2APart,
      requestConverter: toAgentRunRequest,
      eventConverter,
    });
  });

  it('ignores executeInterceptors, which is not a converter slot', () => {
    expect(
      resolveConverters({executeInterceptors: [{beforeAgent: async (c) => c}]}),
    ).toEqual({
      a2aPartConverter: toGenAIPart,
      genAIPartConverter: toA2APart,
      requestConverter: toAgentRunRequest,
      eventConverter: toA2AArtifactUpdateEvent,
    });
  });
});
