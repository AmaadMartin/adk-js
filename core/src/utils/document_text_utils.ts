/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import AdmZip from 'adm-zip';
import {formatError} from './error_utils.js';
import {getLogger} from './logger.js';

const logger = getLogger();

/**
 * Largest amount of XML read out of one zip member. A document is untrusted
 * input, so this bounds the memory a zip bomb can claim.
 */
export const MAX_XML_BYTES = 10 * 1024 * 1024;

/** Zip member holding the body of a DOCX document. */
const DOCX_BODY_ENTRY = 'word/document.xml';

/** Namespace URI of WordprocessingML, whose prefix the document declares. */
const WORDPROCESSINGML_NAMESPACE =
  /xmlns:(\w+)="http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main"/;

/** Prefix WordprocessingML uses when the document declares no other one. */
const DEFAULT_WORDPROCESSINGML_PREFIX = 'w';

/**
 * Reads a zip member and decodes it as UTF-8.
 *
 * A member whose archive declares more than {@link MAX_XML_BYTES} of
 * uncompressed data is never inflated, so a zip bomb cannot claim that memory.
 *
 * @param zip The archive to read from.
 * @param entryName The member to read.
 * @return The member's text, or `undefined` when the member is absent or is
 *     larger than the cap.
 */
function readXmlEntry(zip: AdmZip, entryName: string): string | undefined {
  const entry = zip.getEntry(entryName);
  if (!entry || entry.header.size > MAX_XML_BYTES) {
    return undefined;
  }
  return entry.getData().toString('utf8');
}

/**
 * Extracts the plain text of a DOCX document.
 *
 * The XML is read with regular expressions rather than an XML parser on
 * purpose: a document is untrusted input, and a parser fed a crafted
 * `word/document.xml` is an entity-expansion (XML bomb) sink.
 *
 * @param data The bytes of the DOCX file.
 * @return The document text, or `undefined` when `data` is not a DOCX file.
 */
export function extractDocxText(data: Buffer): string | undefined {
  let xml: string | undefined;
  try {
    xml = readXmlEntry(new AdmZip(data), DOCX_BODY_ENTRY);
  } catch (err: unknown) {
    logger.debug(`Failed to parse docx layout: ${formatError(err)}`);
    return undefined;
  }
  if (xml === undefined) {
    return undefined;
  }

  const prefix =
    WORDPROCESSINGML_NAMESPACE.exec(xml)?.[1] ??
    DEFAULT_WORDPROCESSINGML_PREFIX;
  const runText = new RegExp(
    `<${prefix}:t(?:[^>]*)>([^<]*)</${prefix}:t>`,
    'g',
  );

  const paragraphs: string[] = [];
  for (const paragraph of xml.split(new RegExp(`<${prefix}:p(?:[^>]*)>`))) {
    const runs = [...paragraph.matchAll(runText)].map((match) => match[1]);
    if (runs.length > 0) {
      paragraphs.push(runs.join(''));
    }
  }
  return paragraphs.join('\n');
}
