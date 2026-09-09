/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  LOAD_ARTIFACTS,
  LlmRequest,
  LoadArtifactsTool,
} from '@google/adk';
import {Blob, Part, Type} from '@google/genai';
import AdmZip from 'adm-zip';
import {describe, expect, it} from 'vitest';

/** Builds a tool context serving `artifactsByName`, as the tool sees it. */
function stubContext(artifactsByName: Record<string, Part>): Context {
  return new StubToolContext(artifactsByName) as unknown as Context;
}

/** Builds a request whose last turn asks the tool to load `artifactNames`. */
function requestLoading(artifactNames: string[]): LlmRequest {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'load_artifacts',
              response: {artifact_names: artifactNames},
            },
          },
        ],
      },
    ],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

/** Builds a DOCX buffer whose only paragraph holds `text`. */
function buildDocx(text: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body><w:p><w:t>${text}</w:t></w:p></w:body></w:document>`,
      'utf8',
    ),
  );
  return zip.toBuffer();
}

/** Returns the artifact part the tool appended to `llmRequest`. */
function appendedArtifactPart(llmRequest: LlmRequest): Part {
  const addedContent = llmRequest.contents[llmRequest.contents.length - 1];
  return addedContent.parts![1];
}

class StubToolContext {
  private artifactsByName: Record<string, Part>;

  constructor(artifactsByName: Record<string, Part>) {
    this.artifactsByName = artifactsByName;
  }

  // Minimal stub properties needed to bypass initialized checks
  invocationContext = {
    artifactService: {},
  };

  async listArtifacts(): Promise<string[]> {
    return Object.keys(this.artifactsByName);
  }

  async loadArtifact(name: string): Promise<Part | undefined> {
    return this.artifactsByName[name];
  }
}

describe('LoadArtifactsTool', () => {
  it('computes the correct declaration', () => {
    const tool = new LoadArtifactsTool();
    const declaration = tool._getDeclaration();

    expect(declaration?.name).toEqual('load_artifacts');
    expect(declaration?.description).toContain(
      'Loads artifacts into the session',
    );
    expect(declaration?.parameters).toEqual({
      type: Type.OBJECT,
      properties: {
        artifact_names: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING,
          },
          description: 'The names of the artifacts to load.',
        },
      },
    });
  });

  it('sets correct response on runAsync', async () => {
    const tool = new LoadArtifactsTool();
    const mockContext = {} as unknown as Context;

    const result = await tool.runAsync({
      args: {artifact_names: ['test1']},
      toolContext: mockContext,
    });

    expect(result).toEqual({
      artifact_names: ['test1'],
      status:
        'artifact contents temporarily inserted and removed. to access these artifacts, call load_artifacts tool again.',
    });
  });

  it('has a global instance LOAD_ARTIFACTS', () => {
    expect(LOAD_ARTIFACTS).toBeInstanceOf(LoadArtifactsTool);
  });

  it('converts unsupported text-like inline mime to text parts', async () => {
    const artifactName = 'test.csv';
    const csvString = 'col1,col2\n1,2\n';
    const csvBytesBase64 = Buffer.from(csvString, 'utf8').toString('base64');
    const artifact: Part = {
      inlineData: {data: csvBytesBase64, mimeType: 'application/csv'},
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents[llmRequest.contents.length - 1];
    expect(addedContent.parts![0].text).toEqual(`Artifact ${artifactName} is:`);

    const artifactPart = addedContent.parts![1];
    expect(artifactPart.inlineData).toBeUndefined();
    expect(artifactPart.text).toEqual(csvString);
  });

  it('keeps supported inline mime types (pdf)', async () => {
    const artifactName = 'test.pdf';
    const pdfBytesBase64 = Buffer.from('%PDF-1.4', 'utf8').toString('base64');
    const artifact: Part = {
      inlineData: {data: pdfBytesBase64, mimeType: 'application/pdf'},
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents[llmRequest.contents.length - 1];
    const artifactPart = addedContent.parts![1];
    expect(artifactPart.inlineData).toBeDefined();
    expect(artifactPart.inlineData?.mimeType).toEqual('application/pdf');
  });

  it('keeps supported inline mime types (image)', async () => {
    const artifactName = 'test.png';
    const imgBytesBase64 = Buffer.from('FAKEIMAGE', 'utf8').toString('base64');
    const artifact: Part = {
      inlineData: {data: imgBytesBase64, mimeType: 'image/png'},
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents[llmRequest.contents.length - 1];
    const artifactPart = addedContent.parts![1];
    expect(artifactPart.inlineData).toBeDefined();
    expect(artifactPart.inlineData?.mimeType).toEqual('image/png');
  });

  it('converts unseen binary mime to size string placeholder text', async () => {
    const artifactName = 'test.bin';
    // 5 bytes
    const binBytesBase64 = Buffer.from([1, 2, 3, 4, 5]).toString('base64');
    const artifact: Part = {
      inlineData: {data: binBytesBase64, mimeType: 'application/octet-stream'},
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents[llmRequest.contents.length - 1];
    const artifactPart = addedContent.parts![1];
    expect(artifactPart.inlineData).toBeUndefined();
    // 5 bytes is 0.0048 KB, toFixed(1) -> 0.0 KB
    expect(artifactPart.text).toContain('size: 0.0 KB');
    expect(artifactPart.text).toContain(
      '[Binary artifact: test.bin, type: application/octet-stream',
    );
  });

  it('does not append artifacts if role is not user', async () => {
    const artifactName = 'test.csv';
    const csvString = 'col1,col2\n1,2\n';
    const csvBytesBase64 = Buffer.from(csvString, 'utf8').toString('base64');
    const artifact: Part = {
      inlineData: {data: csvBytesBase64, mimeType: 'application/csv'},
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'model', // Not 'tool'
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    // Content should remain length 1, no artifact appended
    expect(llmRequest.contents.length).toEqual(1);
  });

  it('handles missing artifactService gracefully', async () => {
    const toolContext = new StubToolContext({}) as unknown as Context;
    (
      toolContext.invocationContext as {artifactService: unknown}
    ).artifactService = undefined;

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});
    // Should return early and not throw
    expect(llmRequest.contents.length).toEqual(0);
  });

  it('handles missing or empty artifacts array', async () => {
    const toolContext = new StubToolContext({}) as unknown as Context;
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});
    // Should return early and not throw
    expect(llmRequest.contents.length).toEqual(0);
  });

  it('skips missing artifacts and tries user: prefix', async () => {
    const artifactName = 'test.txt';
    const artifact: Part = {text: 'hello'};

    // Register it as 'user:test.txt'
    const toolContext = new StubToolContext({
      [`user:${artifactName}`]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName, 'missing.txt']},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    // It should load user:test.txt, but skip missing.txt
    expect(llmRequest.contents.length).toEqual(2); // The functionResponse + the single loaded artifact part
    expect(llmRequest.contents[1].parts![1]).toEqual(artifact);
  });

  it('handles parts with no inlineData', async () => {
    const artifactName = 'test.txt';
    const artifact: Part = {text: 'I have no inlineData'};

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents.length).toEqual(2);
    expect(llmRequest.contents[1].parts![1]).toEqual(artifact);
  });

  it('handles parts with inlineData but no data', async () => {
    const artifactName = 'test.txt';
    const artifact: Part = {
      inlineData: {mimeType: 'text/plain'} as unknown as Blob, // missing data field
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents.length).toEqual(2);
    expect(llmRequest.contents[1].parts![1].text).toContain(
      'No inline data was provided',
    );
  });

  it('handles parts with inlineData but no mimeType', async () => {
    const artifactName = 'test.dat';
    const artifact: Part = {
      inlineData: {data: 'YmFzZTY0'} as unknown as Blob, // missing mimeType field
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents.length).toEqual(2);
    expect(llmRequest.contents[1].parts![1].text).toContain(
      '[Binary artifact: test.dat, type: application/octet-stream',
    );
  });

  it('loads artifacts when called in parallel alongside other tools (issue #632)', async () => {
    const artifactName = 'test.txt';
    const textContent = 'Hello World';
    const artifact: Part = {
      text: textContent,
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [{text: 'Run tasks'}],
        },
        {
          role: 'model',
          parts: [
            {functionCall: {name: 'other_tool', args: {}}},
            {
              functionCall: {
                name: 'load_artifacts',
                args: {artifact_names: [artifactName]},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'other_tool',
                response: {status: 'ok'},
              },
            },
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents.find((c) =>
      c.parts?.some((p) => p.text === `Artifact ${artifactName} is:`),
    );
    expect(addedContent).toBeDefined();
    expect(addedContent?.parts?.[1]?.text).toEqual(textContent);
  });

  it('loads artifacts when called sequentially before other tools in the same turn (issue #632)', async () => {
    const artifactName = 'data.txt';
    const textContent = 'Sequential Data';
    const artifact: Part = {
      text: textContent,
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [{text: 'Run tasks'}],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'load_artifacts',
                args: {artifact_names: [artifactName]},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [{functionCall: {name: 'next_tool', args: {}}}],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'next_tool',
                response: {status: 'done'},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents.find((c) =>
      c.parts?.some((p) => p.text === `Artifact ${artifactName} is:`),
    );
    expect(addedContent).toBeDefined();
    expect(addedContent?.parts?.[1]?.text).toEqual(textContent);
  });

  it('does not reload artifacts from previous turns if not called in current turn', async () => {
    const artifactName = 'old.txt';
    const artifact: Part = {
      text: 'Old Content',
    };

    const toolContext = new StubToolContext({
      [artifactName]: artifact,
    }) as unknown as Context;

    const llmRequest: LlmRequest = {
      contents: [
        // Turn 1
        {
          role: 'user',
          parts: [{text: 'Load old artifact'}],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'load_artifacts',
                args: {artifact_names: [artifactName]},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'load_artifacts',
                response: {artifact_names: [artifactName]},
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [{text: 'Old artifact was processed.'}],
        },
        // Turn 2
        {
          role: 'user',
          parts: [{text: 'New question without loading artifact'}],
        },
        {
          role: 'model',
          parts: [{functionCall: {name: 'other_tool', args: {}}}],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'other_tool',
                response: {status: 'ok'},
              },
            },
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    const tool = new LoadArtifactsTool();
    await tool.processLlmRequest({toolContext, llmRequest});

    const addedContent = llmRequest.contents.find((c) =>
      c.parts?.some((p) => p.text === `Artifact ${artifactName} is:`),
    );
    expect(addedContent).toBeUndefined();
  });

  it('appends nothing when the request carries no contents', async () => {
    const toolContext = stubContext({
      'test.txt': {text: 'hello'},
    });
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await new LoadArtifactsTool().processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(0);
    expect(llmRequest.config?.systemInstruction).toBeDefined();
  });

  it('passes non-base64 inline data through as text', async () => {
    const artifactName = 'notes.txt';
    const plainText = 'col1,col2\n1,2\n';
    const toolContext = stubContext({
      [artifactName]: {
        inlineData: {data: plainText, mimeType: 'text/plain'},
      },
    });
    const llmRequest = requestLoading([artifactName]);

    await new LoadArtifactsTool().processLlmRequest({toolContext, llmRequest});

    const artifactPart = appendedArtifactPart(llmRequest);
    expect(artifactPart.inlineData).toBeUndefined();
    expect(artifactPart.text).toEqual(plainText);
  });

  it('converts csv bytes served as octet-stream using the filename', async () => {
    const artifactName = 'test.csv';
    const csvString = 'col1,col2\nval1,val2\n';
    const toolContext = stubContext({
      [artifactName]: {
        inlineData: {
          data: Buffer.from(csvString, 'utf8').toString('base64'),
          mimeType: 'application/octet-stream',
        },
      },
    });
    const llmRequest = requestLoading([artifactName]);

    await new LoadArtifactsTool().processLlmRequest({toolContext, llmRequest});

    const artifactPart = appendedArtifactPart(llmRequest);
    expect(artifactPart.inlineData).toBeUndefined();
    expect(artifactPart.text).toEqual(csvString);
  });

  it('extracts the text of a docx artifact', async () => {
    const artifactName = 'report.docx';
    const toolContext = stubContext({
      [artifactName]: {
        inlineData: {
          data: buildDocx('Quarterly report').toString('base64'),
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      },
    });
    const llmRequest = requestLoading([artifactName]);

    await new LoadArtifactsTool().processLlmRequest({toolContext, llmRequest});

    const artifactPart = appendedArtifactPart(llmRequest);
    expect(artifactPart.inlineData).toBeUndefined();
    expect(artifactPart.text).toEqual('Quarterly report');
  });

  it('extracts the text of a docx artifact whose mime type is wrong', async () => {
    const artifactName = 'minutes.DOCX';
    const toolContext = stubContext({
      [artifactName]: {
        inlineData: {
          data: buildDocx('Mislabelled docx').toString('base64'),
          mimeType: 'application/zip',
        },
      },
    });
    const llmRequest = requestLoading([artifactName]);

    await new LoadArtifactsTool().processLlmRequest({toolContext, llmRequest});

    expect(appendedArtifactPart(llmRequest).text).toEqual('Mislabelled docx');
  });

  it('extracts the text of a docx artifact served as octet-stream', async () => {
    const artifactName = 'document.docx';
    const toolContext = stubContext({
      [artifactName]: {
        inlineData: {
          data: buildDocx('Octet stream docx').toString('base64'),
          mimeType: 'application/octet-stream',
        },
      },
    });
    const llmRequest = requestLoading([artifactName]);

    await new LoadArtifactsTool().processLlmRequest({toolContext, llmRequest});

    expect(appendedArtifactPart(llmRequest).text).toEqual('Octet stream docx');
  });

  it('extracts the text of a docx artifact that has no filename extension', async () => {
    const artifactName = 'inline-file';
    const toolContext = stubContext({
      [artifactName]: {
        inlineData: {
          data: buildDocx('Extensionless docx').toString('base64'),
          mimeType: 'application/octet-stream',
        },
      },
    });
    const llmRequest = requestLoading([artifactName]);

    await new LoadArtifactsTool().processLlmRequest({toolContext, llmRequest});

    expect(appendedArtifactPart(llmRequest).text).toEqual('Extensionless docx');
  });

  it('falls back to the binary placeholder when octet-stream bytes are not a docx', async () => {
    const artifactName = 'inline-file';
    const toolContext = stubContext({
      [artifactName]: {
        inlineData: {
          data: Buffer.from([0, 1, 2, 3]).toString('base64'),
          mimeType: 'application/octet-stream',
        },
      },
    });
    const llmRequest = requestLoading([artifactName]);

    await new LoadArtifactsTool().processLlmRequest({toolContext, llmRequest});

    const artifactPart = appendedArtifactPart(llmRequest);
    expect(artifactPart.inlineData).toBeUndefined();
    expect(artifactPart.text).toContain(
      '[Binary artifact: inline-file, type: application/octet-stream',
    );
    expect(artifactPart.text).toContain('Content cannot be displayed inline.');
  });

  it.each(['image/svg+xml', 'image/svg', 'application/svg+xml', 'image/xml'])(
    'delivers a %s artifact as text rather than inline data',
    async (mimeType) => {
      const artifactName = 'logo.svg';
      const svgMarkup = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
      const toolContext = stubContext({
        [artifactName]: {
          inlineData: {
            data: Buffer.from(svgMarkup, 'utf8').toString('base64'),
            mimeType,
          },
        },
      });
      const llmRequest = requestLoading([artifactName]);

      await new LoadArtifactsTool().processLlmRequest({
        toolContext,
        llmRequest,
      });

      const artifactPart = appendedArtifactPart(llmRequest);
      expect(artifactPart.inlineData).toBeUndefined();
      expect(artifactPart.text).toEqual(svgMarkup);
    },
  );
});
