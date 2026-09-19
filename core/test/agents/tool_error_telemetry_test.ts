/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {functionsExportedForTestingOnly} from '../../src/agents/functions.js';
import {logger} from '../../src/utils/logger.js';

const {detectErrorTypeForTelemetry} = functionsExportedForTestingOnly;

class ReportingTool extends BaseTool {
  constructor(private readonly errorType?: string) {
    super({name: 'reporting_tool', description: 'reports an error type'});
  }
  override async runAsync(): Promise<unknown> {
    return {};
  }
  override detectErrorInResponse(): string | undefined {
    return this.errorType;
  }
}

class ThrowingTool extends BaseTool {
  constructor() {
    super({name: 'throwing_tool', description: 'its detector throws'});
  }
  override async runAsync(): Promise<unknown> {
    return {};
  }
  override detectErrorInResponse(): string | undefined {
    throw new Error('detector exploded');
  }
}

function createContext(): Context {
  return new Context({
    functionCallId: 'call-1',
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'agent', model: 'gemini-2.0-flash'}),
      session: createSession({id: 's', appName: 'app', userId: 'u'}),
      sessionService: new InMemorySessionService(),
      pluginManager: new PluginManager([]),
    }),
  });
}

describe('detectErrorTypeForTelemetry', () => {
  it('reports the type the tool detected', () => {
    expect(
      detectErrorTypeForTelemetry(
        new ReportingTool('RESOURCE_NOT_FOUND_FATAL'),
        createContext(),
        {error: 'boom'},
      ),
    ).toBe('RESOURCE_NOT_FOUND_FATAL');
  });

  it('reports nothing for a tool that detected no error', () => {
    expect(
      detectErrorTypeForTelemetry(new ReportingTool(), createContext(), {}),
    ).toBeUndefined();
  });

  it('reports nothing while the tool is asking for credentials', () => {
    const context = createContext();
    context.requestCredential({
      authScheme: {type: 'apiKey', in: 'header', name: 'x-api-key'},
      credentialKey: 'x-api-key',
    });

    expect(
      detectErrorTypeForTelemetry(
        new ReportingTool('SKILL_NOT_FOUND'),
        context,
        {
          error: 'boom',
        },
      ),
    ).toBeUndefined();
  });

  it('reports nothing while the tool is asking for confirmation', () => {
    const context = createContext();
    context.requestConfirmation({
      hint: 'confirm?',
      payload: {},
    });

    expect(
      detectErrorTypeForTelemetry(
        new ReportingTool('SKILL_NOT_FOUND'),
        context,
        {
          error: 'boom',
        },
      ),
    ).toBeUndefined();
  });

  it('swallows a detector that throws, so telemetry cannot break the call', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(
      detectErrorTypeForTelemetry(new ThrowingTool(), createContext(), {}),
    ).toBeUndefined();
    expect(String(warn.mock.calls[0][0])).toContain('detector exploded');

    warn.mockRestore();
  });

  it('reports nothing from the BaseTool default', () => {
    class PlainTool extends BaseTool {
      constructor() {
        super({name: 'plain_tool', description: 'no detector'});
      }
      override async runAsync(): Promise<unknown> {
        return {};
      }
    }

    expect(
      detectErrorTypeForTelemetry(new PlainTool(), createContext(), {
        error: 'boom',
      }),
    ).toBeUndefined();
  });
});
