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

/** Largest number of data rows rendered from one sheet. */
export const MAX_SPREADSHEET_ROWS = 100;

/** Zip member listing a workbook's sheets, in display order. */
const WORKBOOK_ENTRY = 'xl/workbook.xml';

/** Zip member mapping a sheet's relationship id to its worksheet member. */
const WORKBOOK_RELS_ENTRY = 'xl/_rels/workbook.xml.rels';

/** Zip member holding the strings that cells of type `s` refer to. */
const SHARED_STRINGS_ENTRY = 'xl/sharedStrings.xml';

/** One `<sheet>` element of a workbook. */
const SHEET_TAG = /<sheet\b([^>]*)>/g;

/** One `<Relationship>` element of the workbook relationship map. */
const RELATIONSHIP_TAG = /<Relationship\b([^>]*)>/g;

/** One `<si>` shared string, whose runs are concatenated. */
const SHARED_STRING_TAG = /<si\b[^>]*>([\s\S]*?)<\/si>/g;

/** One `<row>` of a worksheet. */
const ROW_TAG = /<row\b[^>]*>([\s\S]*?)<\/row>/g;

/** One `<c>` cell, either self-closing or with a body. */
const CELL_TAG = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

/** A `<t>` text run. */
const TEXT_RUN_TAG = /<t\b[^>]*>([^<]*)<\/t>/g;

/** The `<v>` value of a cell. */
const CELL_VALUE_TAG = /<v\b[^>]*>([\s\S]*?)<\/v>/;

/** XML entities that appear in spreadsheet text, most specific first. */
const XML_ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  [/&amp;/g, '&'],
];

/** Reads the value of `name` from a serialized XML attribute list. */
function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1];
}

/** Replaces the XML entities that a spreadsheet uses with their characters. */
function decodeXmlEntities(text: string): string {
  return XML_ENTITIES.reduce(
    (decoded, [entity, character]) => decoded.replace(entity, character),
    text,
  );
}

/** Concatenates every `<t>` run of `xml` and decodes its entities. */
function joinTextRuns(xml: string): string {
  const runs = [...xml.matchAll(TEXT_RUN_TAG)].map((match) => match[1]);
  return decodeXmlEntities(runs.join(''));
}

/** Converts the column letters of a cell reference to a zero-based index. */
function columnIndex(cellReference: string): number {
  let index = 0;
  for (const letter of cellReference.toUpperCase()) {
    if (letter < 'A' || letter > 'Z') {
      break;
    }
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** Reads the shared string table, indexed as cells of type `s` refer to it. */
function readSharedStrings(zip: AdmZip): string[] {
  const xml = readXmlEntry(zip, SHARED_STRINGS_ENTRY);
  if (xml === undefined) {
    return [];
  }
  return [...xml.matchAll(SHARED_STRING_TAG)].map((match) =>
    joinTextRuns(match[1]),
  );
}

/** Maps each relationship id of the workbook to its zip member. */
function readSheetMembers(zip: AdmZip): Map<string, string> {
  const members = new Map<string, string>();
  const xml = readXmlEntry(zip, WORKBOOK_RELS_ENTRY);
  if (xml === undefined) {
    return members;
  }
  for (const [, attributes] of xml.matchAll(RELATIONSHIP_TAG)) {
    const id = attribute(attributes, 'Id');
    const target = attribute(attributes, 'Target');
    if (id && target) {
      members.set(
        id,
        target.startsWith('/') ? target.slice(1) : `xl/${target}`,
      );
    }
  }
  return members;
}

/** Reads one cell's text, resolving shared and inline strings. */
function readCell(
  attributes: string,
  body: string | undefined,
  sharedStrings: string[],
): string {
  const type = attribute(attributes, 't');
  if (type === 'inlineStr') {
    return joinTextRuns(body ?? '');
  }
  const value = body === undefined ? undefined : CELL_VALUE_TAG.exec(body)?.[1];
  if (value === undefined) {
    return '';
  }
  if (type === 's') {
    return sharedStrings[Number(value)] ?? '';
  }
  return decodeXmlEntities(value);
}

/**
 * Reads a worksheet into rows of cell text, placing each cell at the column
 * its reference names so that a sparse row does not shift its neighbours.
 */
function readRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  for (const [, rowXml] of xml.matchAll(ROW_TAG)) {
    const cells: string[] = [];
    for (const [, attributes, body] of rowXml.matchAll(CELL_TAG)) {
      const reference = attribute(attributes, 'r');
      const index = reference ? columnIndex(reference) : cells.length;
      cells[index < 0 ? cells.length : index] = readCell(
        attributes,
        body,
        sharedStrings,
      );
    }
    rows.push([...cells].map((cell) => cell ?? ''));
  }
  return rows;
}

/** Renders one cell for a markdown table. */
function markdownCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** Renders one row for a markdown table. */
function markdownRow(cells: string[], width: number): string {
  const padded = Array.from({length: width}, (_, i) =>
    markdownCell(cells[i] ?? ''),
  );
  return `| ${padded.join(' | ')} |`;
}

/** Renders one sheet as a markdown table under a heading. */
function renderSheet(name: string, rows: string[][]): string {
  const [header, ...dataRows] = rows;
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const shown = dataRows.slice(0, MAX_SPREADSHEET_ROWS);

  const lines = [
    markdownRow(header, width),
    `| ${Array.from({length: width}, () => ':---').join(' | ')} |`,
    ...shown.map((row) => markdownRow(row, width)),
  ];
  const truncation =
    dataRows.length > MAX_SPREADSHEET_ROWS
      ? `\n\n[Output is limited to the first ${MAX_SPREADSHEET_ROWS} rows. Total rows: ${dataRows.length}]`
      : '';
  return `### Sheet: ${name}\n\n${lines.join('\n')}${truncation}`;
}

/**
 * Renders the sheets of an XLSX workbook as markdown tables.
 *
 * The first row of each sheet is its header, and a sheet with no rows below
 * the header is left out. Each sheet is capped at {@link MAX_SPREADSHEET_ROWS}
 * data rows, with a notice naming the true row count.
 *
 * Cells are rendered from their stored values, so a date held as a serial
 * number renders as that number. The legacy binary `.xls` format is not a zip
 * and is reported as an invalid format.
 *
 * @param data The bytes of the XLSX file.
 * @return The markdown tables, or a bracketed message describing why the
 *     workbook could not be read.
 */
export function spreadsheetToMarkdown(data: Buffer): string {
  let zip: AdmZip;
  let workbook: string | undefined;
  try {
    zip = new AdmZip(data);
    workbook = readXmlEntry(zip, WORKBOOK_ENTRY);
  } catch (err: unknown) {
    return `[Invalid spreadsheet format: ${formatError(err)}]`;
  }
  if (workbook === undefined) {
    return `[Invalid spreadsheet format: ${WORKBOOK_ENTRY} is missing]`;
  }

  try {
    const sharedStrings = readSharedStrings(zip);
    const members = readSheetMembers(zip);
    const sections: string[] = [];

    [...workbook.matchAll(SHEET_TAG)].forEach(([, attributes], position) => {
      const relationshipId = attribute(attributes, 'r:id');
      const member =
        (relationshipId && members.get(relationshipId)) ||
        `xl/worksheets/sheet${position + 1}.xml`;
      const sheetXml = readXmlEntry(zip, member);
      if (sheetXml === undefined) {
        return;
      }
      const rows = readRows(sheetXml, sharedStrings);
      if (rows.length < 2) {
        return;
      }
      sections.push(
        renderSheet(
          attribute(attributes, 'name') ?? `Sheet${position + 1}`,
          rows,
        ),
      );
    });

    return sections.length > 0 ? sections.join('\n\n') : '[Empty Spreadsheet]';
  } catch (err: unknown) {
    return `[Error parsing spreadsheet: ${formatError(err)}]`;
  }
}
