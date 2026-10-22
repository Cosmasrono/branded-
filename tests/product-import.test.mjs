import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProductCsv, validateProductRows } from '../src/lib/product-import.mjs';

const base = { name: 'Product', category: 'General', price: '100', costPrice: '60', stock: '10', sku: 'P-1' };

test('parses BOM, quoted commas, escaped quotes and multiline descriptions', () => {
  const rows = parseProductCsv('\uFEFFname,category,price,stock,sku,description\r\n"Product, one",General,100,10,P-1,"A ""quoted"" label\nsecond line"\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Product, one');
  assert.equal(rows[0].description, 'A "quoted" label\nsecond line');
  assert.equal(validateProductRows(rows).errors.length, 0);
});

test('rejects malformed files and unsupported headers instead of losing data', () => {
  for (const csv of ['', 'name,sku\nTest,A', 'name,category,price,stock,sku\n"unfinished', 'name,category,price,stock,sku\nTest,General,1,2', 'name,category,price,stock,sku,expiry\nTest,General,1,2,A,2027-01-01']) {
    assert.throws(() => parseProductCsv(csv));
  }
});

test('maps pharmacy values and preserves unsupported dosage form', () => {
  const { products, errors } = validateProductRows([{ ...base, dosageForm: 'Spray', requiresPrescription: 'FALSE', description: 'Label' }]);
  assert.deepEqual(errors, []);
  assert.equal(products[0].dosageForm, 'other');
  assert.equal(products[0].description, 'Label\nOriginal dosage form: Spray');
  assert.equal(products[0].prescriptionRequired, false);
  assert.equal(products[0].totalCost, 600);
  const supported = validateProductRows([{ ...base, dosageForm: 'Tablet', requiresPrescription: 'true' }]).products[0];
  assert.equal(supported.dosageForm, 'tablet');
  assert.equal(supported.prescriptionRequired, true);
});

test('rejects duplicate SKUs and reports source row numbers', () => {
  const { errors } = validateProductRows([base, { ...base, rowNumber: 15 }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rowNumber, 15);
  assert.match(errors[0].message, /Duplicate SKU/);
});

test('rejects invalid prices, quantities and prescription flags', () => {
  for (const patch of [{ price: '' }, { price: '-1' }, { price: 'Infinity' }, { costPrice: 'abc' }, { stock: '1.5' }, { stock: '-2' }, { stock: '2147483648' }, { requiresPrescription: 'maybe' }, { sku: '' }]) {
    assert.equal(validateProductRows([{ ...base, ...patch }]).errors.length, 1, JSON.stringify(patch));
  }
  assert.equal(validateProductRows([{ ...base, price: '0', stock: '0', costPrice: '' }]).errors.length, 0);
});

test('enforces the row limit', () => {
  assert.throws(() => validateProductRows(Array(5001).fill(base)), /5,000/);
});
