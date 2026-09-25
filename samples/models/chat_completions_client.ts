/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CompletionRequest,
  LiteLlmClient,
  ModelResponse,
} from '@google/adk';

/**
 * A `LiteLlmClient` for any server that speaks the OpenAI chat-completions
 * protocol: a LiteLLM proxy, OpenAI itself, or a local model server.
 *
 * `LiteLlm` hands the client a request that is already in chat-completions
 * form, so the client's only job is transport: send it, and hand back the
 * response or, when streaming, one parsed chunk per server-sent event.
 */
export class ChatCompletionsClient implements LiteLlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async acompletion(request: CompletionRequest): Promise<ModelResponse> {
    const response = await this.post(request);
    return (await response.json()) as ModelResponse;
  }

  async *completion(request: CompletionRequest): AsyncIterable<ModelResponse> {
    const response = await this.post(request);
    if (!response.body) {
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        return;
      }
      buffered += decoder.decode(value, {stream: true});
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const data = line.startsWith('data:') ? line.slice(5).trim() : '';
        if (!data) {
          continue;
        }
        if (data === '[DONE]') {
          return;
        }
        yield withFunctionType(JSON.parse(data) as ModelResponse);
      }
    }
  }

  private async post(request: CompletionRequest): Promise<Response> {
    const {additionalArgs, ...body} = request;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? {Authorization: `Bearer ${this.apiKey}`} : {}),
      },
      body: JSON.stringify({...body, ...additionalArgs}),
    });
    if (response.status >= 400) {
      throw new Error(
        `Chat completions request failed with status ${response.status}: ` +
          (await response.text()),
      );
    }
    return response;
  }
}

/**
 * OpenAI sends `type: 'function'` on the first delta of a streamed tool call
 * only. `LiteLlm` reads tool calls by that type, as the Python `litellm`
 * objects it was ported against always carry it, so fill it in on every delta.
 */
function withFunctionType(chunk: ModelResponse): ModelResponse {
  for (const choice of chunk.choices ?? []) {
    for (const toolCall of choice.delta?.tool_calls ?? []) {
      toolCall.type = 'function';
    }
  }
  return chunk;
}
