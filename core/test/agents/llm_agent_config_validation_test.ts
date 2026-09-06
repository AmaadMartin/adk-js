/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionTool, LlmAgent, LlmAgentConfig} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';

/**
 * Builds an agent from a document-shaped object.
 *
 * A caller that builds an agent from parsed YAML or JSON has no object literal
 * for TypeScript to check, which is the case these errors exist for. The extra
 * keys are declared here so the test states them, rather than casting them
 * past the compiler at each call.
 */
function buildFromDocument(
  config: LlmAgentConfig & Record<string, unknown>,
): LlmAgent {
  return new LlmAgent(config);
}

describe('LlmAgent misplaced generation settings', () => {
  it('names generateContentConfig for a generation setting', () => {
    expect(() => {
      buildFromDocument({name: 'test_agent', temperature: 0.2});
    }).toThrow(
      'temperature is a GenerateContentConfig field. Pass ' +
        'generateContentConfig={temperature: ...} instead.',
    );
  });

  it('names every misplaced setting in one error', () => {
    expect(() => {
      buildFromDocument({name: 'test_agent', temperature: 0.2, topP: 0.95});
    }).toThrow(
      'temperature, topP are GenerateContentConfig fields. Pass ' +
        'generateContentConfig={temperature: ..., topP: ...} instead.',
    );
  });

  it('points systemInstruction at the instruction option', () => {
    expect(() => {
      buildFromDocument({
        name: 'test_agent',
        systemInstruction: 'You are helpful.',
      });
    }).toThrow(/LlmAgent\.instruction/);
  });

  it('points responseSchema at the outputSchema option', () => {
    expect(() => {
      buildFromDocument({name: 'test_agent', responseSchema: {type: 'string'}});
    }).toThrow(/LlmAgent\.outputSchema/);
  });

  it('points baseUrl at the model option', () => {
    expect(() => {
      buildFromDocument({name: 'test_agent', baseUrl: 'https://example.com'});
    }).toThrow(/LlmAgent\.model/);
  });

  it('points httpOptions carrying a base URL at the model option', () => {
    expect(() => {
      buildFromDocument({
        name: 'test_agent',
        httpOptions: {baseUrl: 'https://example.com'},
      });
    }).toThrow(
      'Base URL is a transport setting and must be set via LlmAgent.model, ' +
        'not via LlmAgent(httpOptions=...).',
    );
  });

  it('treats httpOptions without a base URL as a generation setting', () => {
    expect(() => {
      buildFromDocument({name: 'test_agent', httpOptions: {timeout: 10}});
    }).toThrow(/httpOptions is a GenerateContentConfig field/);
  });

  it('names a redirect and a misplaced setting in one error', () => {
    let message = '';
    try {
      buildFromDocument({
        name: 'test_agent',
        systemInstruction: 'You are helpful.',
        temperature: 0.1,
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('LlmAgent.instruction');
    expect(message).toContain('temperature is a GenerateContentConfig field');
  });

  it('names an unrecognized key alongside a misplaced setting', () => {
    let message = '';
    try {
      buildFromDocument({name: 'test_agent', temperatur: 0.2, topK: 5});
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('topK is a GenerateContentConfig field');
    expect(message).toContain('Extra inputs are not permitted: temperatur.');
  });

  it('ignores a key that is present but undefined', () => {
    // Spreading an optional value leaves the key behind with no value, which
    // says nothing about where the setting belongs.
    const agent = buildFromDocument({
      name: 'test_agent',
      temperature: undefined,
    });

    expect(agent.name).toBe('test_agent');
  });

  it('still reports a misplaced setting beside an undefined one', () => {
    expect(() => {
      buildFromDocument({
        name: 'test_agent',
        temperature: undefined,
        topP: 0.95,
      });
    }).toThrow(/topP is a GenerateContentConfig field/);
  });

  it('accepts an unrecognized key on its own', () => {
    const agent = buildFromDocument({name: 'test_agent', notAField: true});

    expect(agent.name).toBe('test_agent');
  });

  it('accepts tools, which name a field on both models', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      tools: [
        new FunctionTool({
          name: 'a_tool',
          description: 'a tool',
          parameters: z.object({}),
          execute: () => 'ok',
        }),
      ],
      generateContentConfig: {temperature: 0.2},
    });

    expect(agent.tools).toHaveLength(1);
    expect(agent.generateContentConfig?.temperature).toBe(0.2);
  });

  it('applies the same rejection to a subclass', () => {
    class ChildAgent extends LlmAgent {}
    const config: LlmAgentConfig & Record<string, unknown> = {
      name: 'test_agent',
      temperature: 0.1,
    };

    expect(() => {
      new ChildAgent(config);
    }).toThrow(/temperature is a GenerateContentConfig field/);
  });
});

describe('LlmAgent generateContentConfig validation', () => {
  it('tells the caller to move tools onto the agent', () => {
    expect(() => {
      new LlmAgent({
        name: 'test_agent',
        generateContentConfig: {tools: [{functionDeclarations: []}]},
      });
    }).toThrow(/Move your tools/);
  });

  it('tells the caller to move the system instruction onto the agent', () => {
    expect(() => {
      new LlmAgent({
        name: 'test_agent',
        generateContentConfig: {systemInstruction: 'You are helpful.'},
      });
    }).toThrow(/Move your instruction/);
  });

  it('tells the caller to move the response schema onto the agent', () => {
    expect(() => {
      new LlmAgent({
        name: 'test_agent',
        generateContentConfig: {responseSchema: {type: Type.STRING}},
      });
    }).toThrow(/Move your schema/);
  });

  it('rejects a base URL on the request transport options', () => {
    expect(() => {
      new LlmAgent({
        name: 'test_agent',
        generateContentConfig: {
          httpOptions: {baseUrl: 'http://localhost:8080'},
        },
      });
    }).toThrow(/Base URL is a transport setting/);
  });

  it('accepts transport options that carry no base URL', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      generateContentConfig: {httpOptions: {timeout: 10}},
    });

    expect(agent.generateContentConfig?.httpOptions?.timeout).toBe(10);
  });
});
