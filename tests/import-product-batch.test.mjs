import test from 'node:test';
import assert from 'node:assert/strict';
import { importProductsTransactional as importProductBatch } from '../src/lib/import-product-batch.mjs';

test('overlaps at most four transactions, shares categories, and preserves stock/audits', async () => {
  let active = 0, peak = 0, categories = 0;
  const writes = [], audits = [];
  const prisma = {
    category: { upsert: async () => { categories++; return { id: 'category' }; } },
    $transaction: async callback => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      try {
        return await callback({
          product: { create: async ({ data }) => { writes.push(data); return { id: data.sku }; } },
          auditLog: { create: async ({ data }) => audits.push(data) },
        });
      } finally { active--; }
    },
  };
  const products = Array.from({ length: 12 }, (_, i) => ({ sku: `P${i}`, rowNumber: i + 2, category: 'General', quantityInStock: i }));
  const result = await importProductBatch({ prisma, products, existingSkus: new Set(['P11']), branchId: 'branch', userId: 'user' });
  assert.deepEqual(result, { imported: 11, skipped: 1, errors: [] });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(categories, 1);
  assert.equal(audits.length, 11);
  for (const data of writes) {
    assert.equal(data.branchStocks.create.quantityInStock, data.quantityInStock);
    assert.equal(data.branchStocks.create.branchId, 'branch');
    assert.equal(data.categoryId, 'category');
    assert.equal(data.stockMovements?.create.quantity, data.quantityInStock || undefined);
    assert.ok(audits.some(a => a.auditableId === data.sku && a.userId === 'user'));
  }
});

test('waits for workers and reports failures even if duplicate lookup fails', async () => {
  const prisma = {
    category: { upsert: async () => ({ id: 'category' }) },
    product: { findUnique: async ({ where }) => {
      if (where.sku === 'duplicate') return { id: 'existing' };
      throw new Error('offline');
    } },
    $transaction: async callback => callback({
      product: { create: async ({ data }) => {
        if (data.sku !== 'good') throw new Error('write failed');
        return { id: 'good' };
      } },
      auditLog: { create: async () => {} },
    }),
  };
  const products = ['bad', 'duplicate', 'good'].map((sku, i) => ({ sku, rowNumber: i + 2, category: 'General', quantityInStock: 1 }));
  const result = await importProductBatch({ prisma, products, existingSkus: new Set(), branchId: 'branch', userId: 'user' });
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].rowNumber, 2);
});

test('retries temporary category and transaction errors without duplicating successful writes', async () => {
  let categoryAttempts = 0, transactionAttempts = 0, writes = 0, audits = 0;
  const prisma = {
    category: { upsert: async () => {
      if (++categoryAttempts === 1) throw Object.assign(new Error('conflict'), { code: 'P2034' });
      return { id: 'category' };
    } },
    $transaction: async (callback, options) => {
      assert.deepEqual(options, { maxWait: 10000, timeout: 30000 });
      if (++transactionAttempts === 1) throw Object.assign(new Error('expired'), { code: 'P2028' });
      return callback({
        product: { create: async () => { writes++; return { id: 'product' }; } },
        auditLog: { create: async () => { audits++; } },
      });
    },
  };
  const result = await importProductBatch({ prisma, products: [{ sku: 'retry', category: 'General', rowNumber: 493, quantityInStock: 1 }], existingSkus: new Set(), branchId: 'branch', userId: 'user' });
  assert.deepEqual(result, { imported: 1, skipped: 0, errors: [] });
  assert.equal(categoryAttempts, 2);
  assert.equal(transactionAttempts, 2);
  assert.equal(writes, 1);
  assert.equal(audits, 1);
});

test('limits retries and reports a safe error code without raw database details', async () => {
  let attempts = 0;
  const prisma = {
    category: { upsert: async () => ({ id: 'category' }) },
    $transaction: async () => { attempts++; throw Object.assign(new Error('private database details'), { code: 'P2034' }); },
    product: { findUnique: async () => null },
  };
  const result = await importProductBatch({ prisma, products: [{ sku: 'fail', category: 'General', rowNumber: 494, quantityInStock: 1 }], existingSkus: new Set(), branchId: 'branch', userId: 'user' });
  assert.equal(attempts, 3);
  assert.equal(result.imported, 0);
  assert.equal(result.errors[0].code, 'P2034');
  assert.match(result.errors[0].message, /Database write conflict/);
  assert.doesNotMatch(result.errors[0].message, /private database details/);
});
