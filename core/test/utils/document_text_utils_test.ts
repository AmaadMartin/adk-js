/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import AdmZip from 'adm-zip';
import {describe, expect, it} from 'vitest';
import {
  extractDocxText,
  MAX_SPREADSHEET_ROWS,
  MAX_XML_BYTES,
  spreadsheetToMarkdown,
} from '../../src/utils/document_text_utils.js';

const WORDPROCESSINGML_NAMESPACE =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Builds a DOCX buffer whose body is `documentXml`. */
function buildDocx(documentXml: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  return zip.toBuffer();
}

/** Wraps `body` in a WordprocessingML document declaring `prefix`. */
function wordDocument(body: string, prefix = 'w'): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<${prefix}:document xmlns:${prefix}="${WORDPROCESSINGML_NAMESPACE}">` +
    `<${prefix}:body>${body}</${prefix}:body></${prefix}:document>`
  );
}

describe('extractDocxText', () => {
  it('extracts the text of a minimal document', () => {
    const docx = buildDocx(wordDocument('<w:p><w:t>Hello DOCX</w:t></w:p>'));

    expect(extractDocxText(docx)).toEqual('Hello DOCX');
  });

  it('honours a custom namespace prefix', () => {
    const docx = buildDocx(
      wordDocument('<ns0:p><ns0:t>Custom prefix</ns0:t></ns0:p>', 'ns0'),
    );

    expect(extractDocxText(docx)).toEqual('Custom prefix');
  });

  it('joins runs within a paragraph and separates paragraphs with newlines', () => {
    const docx = buildDocx(
      wordDocument(
        '<w:p><w:t>Hello </w:t><w:t xml:space="preserve">world</w:t></w:p>' +
          '<w:p><w:t>Second</w:t></w:p>' +
          '<w:p/>',
      ),
    );

    expect(extractDocxText(docx)).toEqual('Hello world\nSecond');
  });

  it('assumes the w prefix when the document declares no namespace', () => {
    const docx = buildDocx(
      '<w:document><w:p><w:t>No xmlns</w:t></w:p></w:document>',
    );

    expect(extractDocxText(docx)).toEqual('No xmlns');
  });

  it('returns an empty string for a document body holding no runs', () => {
    const docx = buildDocx(wordDocument('<w:p/>'));

    expect(extractDocxText(docx)).toEqual('');
  });

  it('returns undefined for a buffer that is not a zip', () => {
    expect(extractDocxText(Buffer.from('not a zip at all', 'utf8'))).toBe(
      undefined,
    );
  });

  it('returns undefined for a zip without a document body', () => {
    const zip = new AdmZip();
    zip.addFile('word/styles.xml', Buffer.from('<styles/>', 'utf8'));

    expect(extractDocxText(zip.toBuffer())).toBeUndefined();
  });

  it('refuses to inflate a document body larger than the cap', () => {
    const oversized =
      `<w:document xmlns:w="${WORDPROCESSINGML_NAMESPACE}"><w:p><w:t>` +
      'A'.repeat(MAX_XML_BYTES) +
      '</w:t></w:p></w:document>';

    expect(extractDocxText(buildDocx(oversized))).toBeUndefined();
  });
});

const WORKBOOK_RELATIONSHIP =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

interface SheetFixture {
  name: string;
  rowsXml: string;
}

/** Builds an XLSX buffer from sheets and an optional shared string table. */
function buildXlsx(
  sheets: SheetFixture[],
  sharedStrings: string[] = [],
  options: {omitRels?: boolean} = {},
): Buffer {
  const zip = new AdmZip();
  const sheetTags = sheets
    .map(
      (sheet, i) =>
        `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join('');
  zip.addFile(
    'xl/workbook.xml',
    Buffer.from(`<workbook><sheets>${sheetTags}</sheets></workbook>`, 'utf8'),
  );

  if (!options.omitRels) {
    const relationships = sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${WORKBOOK_RELATIONSHIP}"` +
          ` Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('');
    zip.addFile(
      'xl/_rels/workbook.xml.rels',
      Buffer.from(`<Relationships>${relationships}</Relationships>`, 'utf8'),
    );
  }

  if (sharedStrings.length > 0) {
    const items = sharedStrings
      .map((text) => `<si><t>${text}</t></si>`)
      .join('');
    zip.addFile(
      'xl/sharedStrings.xml',
      Buffer.from(`<sst>${items}</sst>`, 'utf8'),
    );
  }

  sheets.forEach((sheet, i) => {
    zip.addFile(
      `xl/worksheets/sheet${i + 1}.xml`,
      Buffer.from(
        `<worksheet><sheetData>${sheet.rowsXml}</sheetData></worksheet>`,
        'utf8',
      ),
    );
  });
  return zip.toBuffer();
}

/** Builds a `<row>` whose cells hold literal numbers, from column A onwards. */
function numberRow(rowNumber: number, values: number[]): string {
  const cells = values
    .map(
      (value, i) =>
        `<c r="${String.fromCharCode(65 + i)}${rowNumber}"><v>${value}</v></c>`,
    )
    .join('');
  return `<row r="${rowNumber}">${cells}</row>`;
}

describe('spreadsheetToMarkdown', () => {
  it('renders a sheet as a markdown table under its name', () => {
    const xlsx = buildXlsx(
      [
        {
          name: 'Sheet1',
          rowsXml:
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
            numberRow(2, [1, 2]) +
            numberRow(3, [3, 4]),
        },
      ],
      ['col1', 'col2'],
    );

    expect(spreadsheetToMarkdown(xlsx)).toEqual(
      '### Sheet: Sheet1\n\n' +
        '| col1 | col2 |\n' +
        '| :--- | :--- |\n' +
        '| 1 | 2 |\n' +
        '| 3 | 4 |',
    );
  });

  it('resolves inline strings and keeps a sparse cell in its own column', () => {
    const xlsx = buildXlsx([
      {
        name: 'Sparse',
        rowsXml:
          '<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c>' +
          '<c r="C1" t="inlineStr"><is><t>third</t></is></c></row>' +
          '<row r="2"><c r="A2"><v>1</v></c><c r="C2"><v>3</v></c></row>',
      },
    ]);

    expect(spreadsheetToMarkdown(xlsx)).toContain('| first |  | third |');
    expect(spreadsheetToMarkdown(xlsx)).toContain('| 1 |  | 3 |');
  });

  it('reads sheets positionally when the relationship map is absent', () => {
    const xlsx = buildXlsx(
      [{name: 'Positional', rowsXml: numberRow(1, [1]) + numberRow(2, [2])}],
      [],
      {omitRels: true},
    );

    expect(spreadsheetToMarkdown(xlsx)).toContain('### Sheet: Positional');
  });

  it('decodes xml entities and escapes a pipe inside a cell', () => {
    const xlsx = buildXlsx(
      [
        {
          name: 'Escapes',
          rowsXml:
            '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>1</v></c></row>',
        },
      ],
      ['a &amp; b', 'left | right'],
    );

    const markdown = spreadsheetToMarkdown(xlsx);
    expect(markdown).toContain('| a & b |');
    expect(markdown).toContain('| left \\| right |');
  });

  it('caps a sheet at one hundred data rows', () => {
    expect(MAX_SPREADSHEET_ROWS).toEqual(100);
  });

  it('truncates a sheet at the row cap and reports the real row count', () => {
    // The counts are written out rather than derived from the cap, so that
    // raising the cap makes this test fail instead of moving with it.
    const rows = [numberRow(1, [999])];
    for (let i = 0; i <= 100; i++) {
      rows.push(numberRow(i + 2, [i]));
    }
    const xlsx = buildXlsx([{name: 'Large', rowsXml: rows.join('')}]);

    const markdown = spreadsheetToMarkdown(xlsx);
    expect(markdown).toContain('Output is limited to the first 100 rows');
    expect(markdown).toContain('Total rows: 101');
    const tableLines = markdown
      .split('\n')
      .filter((line) => line.startsWith('|'));
    expect(tableLines).toHaveLength(102);
    expect(markdown.split('Output is limited')[0]).not.toContain('| 100 |');
  });

  it('leaves out a sheet that has no rows below its header', () => {
    const xlsx = buildXlsx([{name: 'HeaderOnly', rowsXml: numberRow(1, [1])}]);

    expect(spreadsheetToMarkdown(xlsx)).toEqual('[Empty Spreadsheet]');
  });

  it('leaves out a sheet whose worksheet member is missing', () => {
    const zip = new AdmZip();
    zip.addFile(
      'xl/workbook.xml',
      Buffer.from(
        '<workbook><sheets><sheet name="Gone" r:id="rId1"/></sheets></workbook>',
        'utf8',
      ),
    );

    expect(spreadsheetToMarkdown(zip.toBuffer())).toEqual(
      '[Empty Spreadsheet]',
    );
  });

  it('reports a parsing error when a worksheet payload is corrupt', () => {
    const xlsx = buildXlsx([
      {
        name: 'Corrupt',
        rowsXml: Array.from({length: 50}, (_, i) => numberRow(i + 1, [i])).join(
          '',
        ),
      },
    ]);
    // Damage the compressed payload of the worksheet and leave every header
    // intact, so the archive opens but the member fails to inflate.
    const member = 'xl/worksheets/sheet1.xml';
    const payloadStart = xlsx.indexOf(member) + member.length + 4;
    for (let i = payloadStart; i < payloadStart + 20; i++) {
      xlsx[i] ^= 0xa5;
    }

    expect(spreadsheetToMarkdown(xlsx)).toContain(
      '[Error parsing spreadsheet:',
    );
  });

  it('reports an invalid format for a buffer that is not a zip', () => {
    expect(
      spreadsheetToMarkdown(Buffer.from('not a workbook', 'utf8')),
    ).toContain('[Invalid spreadsheet format:');
  });

  it('reports an invalid format for a zip without a workbook', () => {
    const zip = new AdmZip();
    zip.addFile('docProps/app.xml', Buffer.from('<Properties/>', 'utf8'));

    expect(spreadsheetToMarkdown(zip.toBuffer())).toEqual(
      '[Invalid spreadsheet format: xl/workbook.xml is missing]',
    );
  });
  it('renders an empty cell for a cell that carries no value', () => {
    const xlsx = buildXlsx([
      {
        name: 'Gaps',
        rowsXml:
          '<row r="1"><c r="A1"><v>1</v></c><c r="B1"/></row>' +
          '<row r="2"><c r="A2"><v>2</v></c><c r="B2"></c></row>',
      },
    ]);

    expect(spreadsheetToMarkdown(xlsx)).toContain('| 2 |  |');
  });

  it('places a cell whose reference has no column letters at the end', () => {
    const xlsx = buildXlsx([
      {
        name: 'Odd',
        rowsXml:
          '<row r="1"><c r="A1"><v>1</v></c><c r="1"><v>2</v></c></row>' +
          '<row r="2"><c r="A2"><v>3</v></c><c r="2"><v>4</v></c></row>',
      },
    ]);

    expect(spreadsheetToMarkdown(xlsx)).toContain('| 3 | 4 |');
  });

  it('renders an empty cell for a shared string index that has no entry', () => {
    const xlsx = buildXlsx(
      [
        {
          name: 'Missing',
          rowsXml:
            '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>7</v></c></row>',
        },
      ],
      ['header'],
    );

    expect(spreadsheetToMarkdown(xlsx)).toEqual(
      '### Sheet: Missing\n\n| header |\n| :--- |\n|  |',
    );
  });

  it('pads a short row and reads cells that carry no reference', () => {
    const xlsx = buildXlsx([
      {
        name: 'Ragged',
        rowsXml:
          '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c>' +
          '<c r="C1"><v>3</v></c></row>' +
          '<row r="2"><c><v>4</v></c><c t="inlineStr"/></row>',
      },
    ]);

    expect(spreadsheetToMarkdown(xlsx)).toContain('| 4 |  |  |');
  });

  it('resolves a relationship target given as an absolute path', () => {
    const zip = new AdmZip();
    zip.addFile(
      'xl/workbook.xml',
      Buffer.from(
        '<workbook><sheets><sheet r:id="rId1"/></sheets></workbook>',
        'utf8',
      ),
    );
    zip.addFile(
      'xl/_rels/workbook.xml.rels',
      Buffer.from(
        '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/>' +
          '<Relationship Type="no-id-or-target"/></Relationships>',
        'utf8',
      ),
    );
    zip.addFile(
      'xl/worksheets/sheet1.xml',
      Buffer.from(
        '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row>' +
          '<row r="2"><c r="A2"><v>2</v></c></row></sheetData></worksheet>',
        'utf8',
      ),
    );

    // The sheet element carries no name, so the position names it.
    expect(spreadsheetToMarkdown(zip.toBuffer())).toContain(
      '### Sheet: Sheet1',
    );
  });
});
