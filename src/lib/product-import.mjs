export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const forms = new Set(['tablet', 'capsule', 'syrup', 'suspension', 'injection', 'cream', 'ointment', 'drops', 'inhaler', 'sachet', 'suppository', 'other']);

// CSV state machine: quoted commas, escaped quotes, multiline fields and UTF-8 BOM.
export function parseProductCsv(text) {
  const records = [];
  let record = [], field = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  function cell() { record.push(field.trim()); field = ''; closed = false; }
  function row() {
    cell();
    if (record.some(Boolean)) records.push(record);
    record = [];
    if (records.length > MAX_IMPORT_ROWS + 1) throw new Error('Maximum 5,000 products per file.');
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += c;
    } else if (c === ',') cell();
    else if (c === '\r' || c === '\n') { row(); if (c === '\r' && text[i + 1] === '\n') i++; }
    else if (c === '"' && !field && !closed) quoted = true;
    else if (closed || c === '"') throw new Error('Malformed CSV quoting. Export the spreadsheet as CSV (UTF-8).');
    else field += c;
  }
  if (quoted) throw new Error('Unclosed quoted field in CSV.');
  row();
  const headers = records.shift();
  if (!headers || !records.length) throw new Error('The CSV has no products.');
  const allowed = new Set(['name', 'category', 'price', 'costPrice', 'stock', 'sku', 'strength', 'dosageForm', 'packSize', 'requiresPrescription', 'description']);
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate column names.');
  const unknown = headers.filter(h => !allowed.has(h));
  if (unknown.length) throw new Error(`Unsupported columns: ${unknown.join(', ')}. Use the CSV template.`);
  for (const key of ['name', 'category', 'price', 'stock', 'sku']) {
    if (!headers.includes(key)) throw new Error(`Missing required column: ${key}.`);
  }
  return records.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Row ${index + 2}: column count does not match the header.`);
    return { ...Object.fromEntries(headers.map((key, i) => [key, values[i]])), rowNumber: index + 2 };
  });
}

export function validateProductRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_IMPORT_ROWS) throw new Error('Supply 1–5,000 product rows.');
  const errors = [], products = [], seen = new Set();
  rows.forEach((row, index) => {
    const rowNumber = Number.isInteger(row?.rowNumber) ? row.rowNumber : index + 2;
    try {
      if (!row || typeof row !== 'object') throw new Error('Invalid product row.');
      const str = key => String(row[key] ?? '').trim();
      const name = str('name'), sku = str('sku'), category = str('category');
      if (!name || !sku || !category) throw new Error('Name, SKU and category are required.');
      if (seen.has(sku)) throw new Error(`Duplicate SKU in file: ${sku}.`);
      seen.add(sku);
      function number(key, optional = false) {
        const value = str(key);
        if (!value && optional) return null;
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new Error(`${key} must be a non-negative number.`);
        const n = Number(value);
        if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) throw new Error(`${key} is too large.`);
        return n;
      }
      const sellingPrice = number('price'), costPrice = number('costPrice', true), quantityInStock = number('stock');
      if (!Number.isInteger(quantityInStock) || quantityInStock > 2147483647) throw new Error('Stock must be a whole number from 0 to 2,147,483,647.');
      const prescription = str('requiresPrescription').toLowerCase();
      if (!['', 'true', 'false', 'yes', 'no', '1', '0'].includes(prescription)) throw new Error('requiresPrescription must be true or false.');
      const originalForm = str('dosageForm');
      const form = originalForm.toLowerCase();
      const mapped = form && !forms.has(form);
      const description = [str('description'), mapped ? `Original dosage form: ${originalForm}` : ''].filter(Boolean).join('\n');
      products.push({ rowNumber, category, name, sku, sellingPrice, costPrice, quantityInStock,
        totalCost: (costPrice || 0) * quantityInStock, strength: str('strength') || null,
        dosageForm: form ? (mapped ? 'other' : form) : null, packSize: str('packSize') || null,
        prescriptionRequired: ['true', 'yes', '1'].includes(prescription), description: description || null });
    } catch (error) { errors.push({ rowNumber, message: error.message }); }
  });
  return { products, errors };
}
