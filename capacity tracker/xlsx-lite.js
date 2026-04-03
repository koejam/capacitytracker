import JSZip from 'jszip';

/**
 * Convert 0-based column index to Excel column letter(s)
 * 0 -> A, 1 -> B, 25 -> Z, 26 -> AA, etc.
 */
function colRef(n) {
  let result = '';
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

/**
 * Parse an XLSX file from an ArrayBuffer
 * Returns {sheets: [{name, data: [[...]]}, ...]}
 */
export async function parseXlsx(arrayBuffer) {
  const zip = new JSZip();
  await zip.loadAsync(arrayBuffer);

  // Read workbook to get sheet names and relationships
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const workbookRelsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');

  // Parse sheet names from workbook.xml
  const sheetMatches = workbookXml.match(/<sheet\s+[^>]*?name="([^"]*)"[^>]*?sheetId="(\d+)"[^>]*?r:id="([^"]*)"[^>]*?\/>/g) || [];
  const sheets = [];

  // Parse relationships to get sheet file mappings
  const relMatches = workbookRelsXml.match(/<Relationship[^>]*?/g) || [];
  const relMap = {};
  relMatches.forEach((relStr) => {
    const idMatch = relStr.match(/Id="([^"]*)"/);
    const targetMatch = relStr.match(/Target="([^"]*)"/);
    if (idMatch && targetMatch) {
      relMap[idMatch[1]] = targetMatch[1];
    }
  });

  // Read shared strings
  let sharedStrings = [];
  try {
    const sharedStringsXml = await zip.file('xl/sharedStrings.xml').async('string');
    const siMatches = sharedStringsXml.match(/<si>[\s\S]*?<\/si>/g) || [];
    sharedStrings = siMatches.map((si) => {
      const tMatch = si.match(/<t[^>]*>([^<]*)<\/t>/);
      return tMatch ? tMatch[1] : '';
    });
  } catch (e) {
    // No shared strings file
  }

  // Parse each sheet
  for (const sheetMatch of sheetMatches) {
    const nameMatch = sheetMatch.match(/name="([^"]*)"/);
    const ridMatch = sheetMatch.match(/r:id="([^"]*)"/);

    if (nameMatch && ridMatch) {
      const name = nameMatch[1];
      const rId = ridMatch[1];
      const filePath = relMap[rId];

      if (filePath) {
        const sheetXml = await zip.file(`xl/${filePath}`).async('string');
        const sheetData = parseSheetData(sheetXml, sharedStrings);
        sheets.push({ name, data: sheetData });
      }
    }
  }

  return { sheets };
}

/**
 * Parse sheet XML and extract cell data
 */
function parseSheetData(sheetXml, sharedStrings) {
  const data = [];
  const rowMatches = sheetXml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];

  rowMatches.forEach((rowStr) => {
    const cellMatches = rowStr.match(/<c[^>]*>[\s\S]*?<\/c>/g) || [];
    const rowData = [];
    let maxCol = -1;

    cellMatches.forEach((cellStr) => {
      const refMatch = cellStr.match(/r="([A-Z]+)(\d+)"/);
      if (refMatch) {
        const colStr = refMatch[1];
        const col = colStrToNum(colStr);
        maxCol = Math.max(maxCol, col);

        // Fill gaps with empty strings
        while (rowData.length <= col) {
          rowData.push('');
        }

        // Extract value
        let value = '';
        const tMatch = cellStr.match(/t="([^"]*)"/);
        const vMatch = cellStr.match(/<v>([^<]*)<\/v>/);

        if (tMatch && tMatch[1] === 's' && vMatch) {
          // Shared string reference
          const idx = parseInt(vMatch[1], 10);
          value = sharedStrings[idx] || '';
        } else if (vMatch) {
          // Direct value
          value = vMatch[1];
          // Try to parse as number
          const num = parseFloat(value);
          if (!isNaN(num)) {
            value = num;
          }
        }

        rowData[col] = value;
      }
    });

    if (rowData.length > 0) {
      data.push(rowData);
    }
  });

  return data;
}

/**
 * Convert Excel column letters to 0-based number
 * A -> 0, Z -> 25, AA -> 26, etc.
 */
function colStrToNum(colStr) {
  let result = 0;
  for (let i = 0; i < colStr.length; i++) {
    result = result * 26 + (colStr.charCodeAt(i) - 64);
  }
  return result - 1;
}

/**
 * Build an XLSX file from sheet data
 * sheets: [{name, data: [[...]], colWidths?: [], merges?: [], formulas?: {}}, ...]
 * Each cell can be: primitive value, or {v: value, t: 'n'|'s', f: formula, s: styleIndex}
 * Returns a Blob
 */
export function buildXlsx(sheets) {
  const zip = new JSZip();

  // Collect all unique strings for sharedStrings.xml
  const stringMap = new Map();
  const stringList = [];

  function addString(str) {
    if (typeof str !== 'string') return -1;
    if (!stringMap.has(str)) {
      stringMap.set(str, stringList.length);
      stringList.push(str);
    }
    return stringMap.get(str);
  }

  // Pre-process all sheets to collect strings
  sheets.forEach((sheet) => {
    if (sheet.data) {
      sheet.data.forEach((row) => {
        row.forEach((cell) => {
          if (cell === null || cell === undefined) return;
          if (typeof cell === 'string') {
            addString(cell);
          } else if (typeof cell === 'object' && cell.v !== undefined) {
            if (typeof cell.v === 'string') {
              addString(cell.v);
            }
          }
        });
      });
    }
  });

  // Build [Content_Types].xml
  const contentTypes = buildContentTypes(sheets.length);
  zip.file('[Content_Types].xml', contentTypes);

  // Build _rels/.rels
  const rels = buildRels();
  zip.folder('_rels').file('.rels', rels);

  // Build xl folder structure
  const xlFolder = zip.folder('xl');

  // Build workbook.xml and workbook.xml.rels
  const { workbook, workbookRels } = buildWorkbook(sheets);
  xlFolder.file('workbook.xml', workbook);
  xlFolder.folder('_rels').file('workbook.xml.rels', workbookRels);

  // Build styles.xml
  const styles = buildStyles();
  xlFolder.file('styles.xml', styles);

  // Build sharedStrings.xml
  const sharedStrings = buildSharedStrings(stringList);
  xlFolder.file('sharedStrings.xml', sharedStrings);

  // Build worksheet files
  const worksheetsFolder = xlFolder.folder('worksheets');
  sheets.forEach((sheet, index) => {
    const sheetNum = index + 1;
    const worksheet = buildWorksheet(sheet, stringMap);
    worksheetsFolder.file(`sheet${sheetNum}.xml`, worksheet);
  });

  return zip.generateAsync({ type: 'blob' });
}

function buildContentTypes(sheetCount) {
  let sheetOverrides = '';
  for (let i = 1; i <= sheetCount; i++) {
    sheetOverrides += `  <Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
${sheetOverrides}</Types>`;
}

function buildRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function buildWorkbook(sheets) {
  let sheetRefs = '';
  sheets.forEach((sheet, index) => {
    sheetRefs += `    <sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 2}"/>\n`;
  });

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${sheetRefs}  </sheets>
</workbook>`;

  let workbookRelRefs = '';
  sheets.forEach((sheet, index) => {
    workbookRelRefs += `  <Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>\n`;
  });
  workbookRelRefs += `  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n`;
  workbookRelRefs += `  <Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>\n`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${workbookRelRefs}</Relationships>`;

  return { workbook, workbookRels };
}

function buildStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts>
    <font><name val="Calibri"/><sz val="11"/><color theme="1"/><family val="2"/></font>
    <font><name val="Calibri"/><sz val="11"/><b/><color theme="1"/><family val="2"/></font>
  </fonts>
  <fills>
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders>
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/>
  </cellXfs>
  <cellStyles>
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
  <numFmts>
    <numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00_);(&quot;$&quot;#,##0.00)"/>
  </numFmts>
</styleSheet>`;
}

function buildSharedStrings(stringList) {
  let content = '';
  stringList.forEach((str) => {
    content += `  <si><t>${escapeXml(str)}</t></si>\n`;
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${stringList.length}" uniqueCount="${stringList.length}">
${content}</sst>`;
}

function buildWorksheet(sheet, stringMap) {
  const data = sheet.data || [];
  const colWidths = sheet.colWidths || [];
  const merges = sheet.merges || [];
  const formulas = sheet.formulas || {};

  // Build col definitions for column widths
  let colDefs = '';
  colWidths.forEach((width, index) => {
    colDefs += `    <col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>\n`;
  });

  // Build rows and cells
  let rowsContent = '';
  data.forEach((row, rowIndex) => {
    const rowNum = rowIndex + 1;
    let cellsContent = '';

    row.forEach((cell, colIndex) => {
      const colLetter = colRef(colIndex);
      const cellRef = `${colLetter}${rowNum}`;

      if (cell === null || cell === undefined) return;

      let cellXml = `      <c r="${cellRef}"`;
      let value = '';
      let type = 's';
      let styleId = '0';
      let formula = '';

      if (typeof cell === 'object' && cell !== null) {
        value = cell.v;
        type = cell.t || (typeof value === 'string' ? 's' : 'n');
        styleId = cell.s !== undefined ? cell.s : '0';
        if (cell.f) {
          formula = cell.f;
        }
      } else {
        value = cell;
        type = typeof value === 'string' ? 's' : 'n';
      }

      // Check formulas map
      if (formulas[cellRef]) {
        formula = formulas[cellRef];
      }

      if (type === 's') {
        const strIndex = stringMap.get(String(value));
        if (strIndex !== undefined) {
          cellXml += ` t="s" s="${styleId}"><v>${strIndex}</v>`;
        } else {
          return;
        }
      } else {
        cellXml += ` t="${type}" s="${styleId}"><v>${value}</v>`;
      }

      if (formula) {
        cellXml = cellXml.replace('</v>', `</v><f>${escapeXml(formula)}</f>`);
      }

      cellXml += '</c>\n';
      cellsContent += cellXml;
    });

    if (cellsContent) {
      rowsContent += `    <row r="${rowNum}">\n${cellsContent}    </row>\n`;
    }
  });

  // Build merge cells
  let mergeCellsContent = '';
  if (merges.length > 0) {
    merges.forEach((merge) => {
      mergeCellsContent += `      <mergeCell ref="${merge}"/>\n`;
    });
  }

  let mergeCellsXml = '';
  if (mergeCellsContent) {
    mergeCellsXml = `  <mergeCells count="${merges.length}">\n${mergeCellsContent}  </mergeCells>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
${colDefs ? `  <cols>\n${colDefs}  </cols>\n` : ''}${rowsContent}  </sheetData>
${mergeCellsXml}</worksheet>`;
}

function escapeXml(str) {
  if (typeof str !== 'string') str = String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
