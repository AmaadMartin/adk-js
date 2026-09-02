/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {maybeBase64ToBytes} from './base64_utils.js';
import {extractDocxText} from './document_text_utils.js';
import {
  isGeminiInlineMimeTypeSupported,
  isSpreadsheetMimeType,
  isTextLikeMimeType,
  normalizeMimeType,
} from './mime_utils.js';
import {spreadsheetToMarkdown} from './spreadsheet_utils.js';

/** MIME type of a DOCX document. */
const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** MIME type an upload carries when its real type is unknown. */
const OCTET_STREAM_MIME_TYPE = 'application/octet-stream';

/** Filename suffixes whose content is text whatever the MIME type says. */
const TEXT_FILE_SUFFIXES = ['.csv', '.txt', '.json', '.xml'];

/** Filename suffixes of a spreadsheet workbook. */
const SPREADSHEET_FILE_SUFFIXES = ['.xlsx', '.xls'];

/**
 * Converts a part the model cannot read into one it can.
 *
 * A part Gemini accepts inline is returned unchanged. Anything else is
 * converted to text: a DOCX document to its extracted text, a text-like
 * payload to its decoded text, and any remaining binary payload to a short
 * placeholder naming the artifact and its size. The conversion never throws;
 * every failure degrades to a text part.
 *
 * A `processArtifact` callback can call this to fall back to the default
 * conversion for an artifact it does not want to handle itself.
 *
 * @param artifact The part to convert.
 * @param artifactName The name the artifact was loaded under. Inline data
 *     carries no filename, so a caller without one passes a stand-in name.
 * @param enableSpreadsheetParsing Whether to render a spreadsheet workbook as
 *     a markdown table instead of a placeholder.
 * @return A part that is safe to send to Gemini.
 */
export function asSafePartForLlm(
  artifact: Part,
  artifactName: string,
  enableSpreadsheetParsing = false,
): Part {
  const inlineData = artifact.inlineData;
  if (!inlineData) {
    return artifact;
  }

  if (isGeminiInlineMimeTypeSupported(inlineData.mimeType)) {
    return artifact;
  }

  const mimeType =
    normalizeMimeType(inlineData.mimeType) || OCTET_STREAM_MIME_TYPE;
  const data = inlineData.data;
  if (!data) {
    return {
      text: `[Artifact: ${artifactName}, type: ${mimeType}. No inline data was provided.]`,
    };
  }

  const bytes = maybeBase64ToBytes(data);
  if (!bytes) {
    return {text: data};
  }

  const loweredName = artifactName.toLowerCase();
  const isDocx =
    mimeType === DOCX_MIME_TYPE ||
    mimeType === OCTET_STREAM_MIME_TYPE ||
    loweredName.endsWith('.docx');
  if (isDocx) {
    const docxText = extractDocxText(bytes);
    if (docxText !== undefined) {
      return {text: docxText};
    }
  }

  if (
    isTextLikeMimeType(mimeType) ||
    TEXT_FILE_SUFFIXES.some((suffix) => loweredName.endsWith(suffix))
  ) {
    try {
      return {text: bytes.toString('utf8')};
    } catch {
      // A buffer over Node's maximum string length cannot be decoded, so the
      // size description below is all that is left to send.
    }
  }

  if (
    enableSpreadsheetParsing &&
    (isSpreadsheetMimeType(mimeType) ||
      SPREADSHEET_FILE_SUFFIXES.some((suffix) => loweredName.endsWith(suffix)))
  ) {
    return {text: spreadsheetToMarkdown(bytes)};
  }

  const sizeKb = bytes.length / 1024;
  return {
    text: `[Binary artifact: ${artifactName}, type: ${mimeType}, size: ${sizeKb.toFixed(1)} KB. Content cannot be displayed inline.]`,
  };
}
