/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Experimental GenAI semantic conventions
 * ../../../docs/guides/telemetry/experimental_semconv/index.md
 *
 * Reports every model call in the experimental OpenTelemetry GenAI semantic
 * conventions. A plugin collects the request and the response, then emits one
 * `gen_ai.client.inference.operation.details` log record and mirrors the same
 * payload onto the active span. A console exporter prints the record.
 *
 * Nothing in the LLM flow calls these setters yet, so the plugin below is how
 * you drive them today.
 *
 * Run (needs a Gemini API key):
 *   export GOOGLE_API_KEY=<your key>
 *   npm run sample -- samples/telemetry/experimental_semconv/agent.ts
 *
 * Send a turn, then type `exit`. The printed record carries the token counts
 * and the finish reason. The message lists reach the span, not the record:
 * `@opentelemetry/sdk-logs` 0.205.0 rejects a list of objects as an attribute.
 */

import {
  App,
  BasePlugin,
  Context,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  maybeLogCompletionDetails,
  maybeSetOtelProviders,
  setOperationDetailsAttributesFromRequest,
  setOperationDetailsAttributesFromResponse,
  setOperationDetailsCommonAttributes,
} from '@google/adk';
import {trace} from '@opentelemetry/api';
import type {AnyValueMap} from '@opentelemetry/api-logs';
import {logs} from '@opentelemetry/api-logs';
import {
  ConsoleLogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';

maybeSetOtelProviders([
  {
    logRecordProcessors: [
      new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()),
    ],
  },
]);

/** Opts in to the conventions and puts the conversation on both sinks. */
const telemetryConfig = {
  shouldUseExperimentalGenaiSemconv: true,
  shouldAddContentToLogs: true,
  shouldAddContentToExperimentalSpans: true,
};

/** Reports one model call in the experimental GenAI semantic conventions. */
class ExperimentalSemconvPlugin extends BasePlugin {
  private details: AnyValueMap = {};
  private common: AnyValueMap = {};

  constructor() {
    super('experimental_semconv');
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<undefined> {
    this.details = {};
    this.common = {};
    setOperationDetailsAttributesFromRequest(this.details, params.llmRequest);
    // The end user's id identifies a person, so it goes in the log-only map and
    // reaches the record only while `shouldAddContentToLogs` is on.
    setOperationDetailsCommonAttributes(
      this.common,
      telemetryConfig,
      {
        'gen_ai.agent.name': params.callbackContext.agentName,
        'gen_ai.conversation.id': params.callbackContext.sessionId,
      },
      {'user.id': params.callbackContext.userId},
    );
    return;
  }

  override async afterModelCallback(params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<undefined> {
    setOperationDetailsAttributesFromResponse(
      params.llmResponse,
      this.details,
      this.common,
    );
    maybeLogCompletionDetails(
      trace.getActiveSpan(),
      logs.getLogger('adk-sample'),
      this.details,
      this.common,
      telemetryConfig,
    );
    return;
  }
}

export const app = new App({
  name: 'experimental_semconv_sample',
  rootAgent: new LlmAgent({
    name: 'weather_agent',
    model: 'gemini-flash-latest',
    instruction: 'Answer in one short sentence.',
  }),
  plugins: [new ExperimentalSemconvPlugin()],
});
