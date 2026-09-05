/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {LLMRegistry} from '../../models/registry.js';

/**
 * The model an environment simulation asks for its JSON documents.
 *
 * The tool connection analyzer and the tool spec mock strategy both send one
 * prompt and read one JSON document back, so both resolve their model through
 * this.
 */
export class SimulationModel {
  private readonly model: string;
  private readonly modelConfig: GenerateContentConfig;

  /**
   * @param model The model to call.
   * @param modelConfig The configuration of that model call.
   */
  constructor(model: string, modelConfig: GenerateContentConfig) {
    this.model = model;
    this.modelConfig = modelConfig;
  }

  /**
   * Sends `prompt` to the model and collects everything it says.
   *
   * The model is resolved here rather than in the constructor, because
   * `Gemini` demands an API key in its own constructor. A simulation that only
   * injects canned responses never calls a model, and must not need a
   * credential to be built.
   *
   * adk-python passes a second `generation_config` holding
   * `response_mime_type: 'application/json'`. `LlmRequest` has one config slot,
   * so the mime type is folded into the caller's config instead.
   *
   * @param prompt The prompt to send.
   * @returns The text of every part the model streamed back, concatenated.
   */
  async generateText(prompt: string): Promise<string> {
    const request = {
      model: this.model,
      contents: [{role: 'user', parts: [{text: prompt}]}],
      config: {...this.modelConfig, responseMimeType: 'application/json'},
      toolsDict: {},
      liveConnectConfig: {},
    };

    let text = '';
    const llm = LLMRegistry.newLlm(this.model);
    for await (const response of llm.generateContentAsync(request)) {
      for (const part of response.content?.parts ?? []) {
        if (part.text) {
          text += part.text;
        }
      }
    }
    return text;
  }
}
