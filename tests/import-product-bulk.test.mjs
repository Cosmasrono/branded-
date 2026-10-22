import test from 'node:test';
import assert from 'node:assert/strict';
import { importProductBatch } from '../src/lib/import-product-batch.mjs';

// In-memory stand-in for the Prisma models the bulk importer touches.
function fakePrisma({ failOn } = {}) {
  const db = { products: [], stocks: [], movements: [], audits: [], categories: new Map() };
  const calls = { createMany: 0, transactions: 0 };
  const maybeFail = (op) => { if (failOn?.(op)) throw Object.assign(new Error('boom'), { code: 'P9999' }); };
  const prisma = {
    db, calls,
    category: { upsert: async ({ where }) => {
      if (!db.categories.has(where.name)) db.categories.set(where.name, { id: `cat-${where.name}`, name: where.name });
      return db.categories.get(where.name);
    } },
    product: {
      createMany: async ({ data }) => { calls.createMany++; maybeFail('product.createMany'); data.forEach(d => db.products.push({ ...d, id: `id-${d.sku}` })); return { count: data.length }; },
      findMany: async ({ where }) => db.products
        .filter(p => where.sku.in.includes(p.sku))
        .filter(p => !where.branchStocks || !db.stocks.some(s => s.productId === p.id)),
      findUnique: async ({ where }) => db.products.find(p => p.sku === where.sku) || null,
    },
    productBranchStock: { createMany: async ({ data }) => { calls.createMany++; maybeFail('productBranchStock.createMany'); db.stocks.push(...data); return { count: data.length }; } },
    stockMovement: { createMany: async ({ data }) => { calls.createMany++; db.movements.push(...data); return { count: data.length }; } },
    auditLog: {
      createMany: async ({ data }) => { calls.createMany++; db.audits.push(...data); return { count: data.length }; },
      create: async ({ data }) => db.audits.push(data),
    },
    $transaction: async (callback) => {
      calls.transactions++;
      return callback({
        product: { create: async ({ data }) => {
          const p = { ...data, id: `id-${data.sku}` };
          delete p.branchStocks; delete p.stockMovements;
          db.products.push(p);
          db.stocks.push({ productId: p.id, ...data.branchStocks.create });
          if (data.stockMovements) db.movements.push({ productId: p.id, ...data.stockMovements.create });
          return p;
        } },
        auditLog: { create: async ({ data }) => db.audits.push(data) },
      });
    },
  };
  return prisma;
}

const rows = (n, stock = (i) => i % 3) => Array.from({ length: n }, (_, i) => ({ sku: `S${i}`, name: `Item ${i}`, rowNumber: i + 2, category: i % 2 ? 'Tablets' : 'Syrups', quantityInStock: stock(i), sellingPrice: 10 }));

test('saves a whole batch with a handful of bulk writes, no per-product transactions', async () => {
  const prisma = fakePrisma();
  const products = rows(500);
  const result = await importProductBatch({ prisma, products, existingSkus: new Set(['S0', 'S1']), branchId: 'b1', userId: 'u1' });
  assert.deepEqual(result, { imported: 498, skipped: 2, errors: [] });
  assert.equal(prisma.calls.transactions, 0);
  assert.ok(prisma.calls.createMany <= 4, `expected ≤4 bulk writes, got ${prisma.calls.createMany}`);
  assert.equal(prisma.db.products.length, 498);
  assert.equal(prisma.db.stocks.length, 498);
  assert.ok(prisma.db.stocks.every(s => s.branchId === 'b1' && s.initialAllocation === s.quantityInStock));
  // movements only for stock > 0, audits for every product
  assert.equal(prisma.db.movements.length, products.slice(2).filter(p => p.quantityInStock > 0).length);
  assert.equal(prisma.db.audits.length, 498);
  assert.ok(prisma.db.products.every(p => p.categoryId === `cat-${p.sku.slice(1) % 2 ? 'Tablets' : 'Syrups'}` && !('rowNumber' in p) && !('category' in p)));
});

test('falls back to per-product transactions when the bulk insert fails', async () => {
  const prisma = fakePrisma({ failOn: (op) => op === 'product.createMany' });
  const result = await importProductBatch({ prisma, products: rows(5), existingSkus: new Set(), branchId: 'b1', userId: 'u1' });
  assert.deepEqual(result, { imported: 5, skipped: 0, errors: [] });
  assert.equal(prisma.calls.transactions, 5);
  assert.equal(prisma.db.products.length, 5);
  assert.equal(prisma.db.stocks.length, 5);
});

test('if stock writes fail after products saved, the fallback repairs stock instead of duplicating products', async () => {
  let stockFailures = 0;
  // The bulk stock write fails (a non-retryable error); the fallback's repair write succeeds.
  const prisma = fakePrisma({ failOn: (op) => op === 'productBranchStock.createMany' && ++stockFailures === 1 });
  const result = await importProductBatch({ prisma, products: rows(4), existingSkus: new Set(), branchId: 'b1', userId: 'u1' });
  assert.equal(result.imported, 4);
  assert.equal(result.skipped, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(prisma.db.products.length, 4, 'no duplicate products');
  assert.equal(prisma.db.stocks.length, 4, 'every product got a stock record');
  assert.equal(prisma.calls.transactions, 0);
});

test('re-importing gives existing products with no stock record one, and adds nothing else', async () => {
  const prisma = fakePrisma();
  prisma.db.products.push({ sku: 'S0', id: 'id-S0', quantityInStock: 7 }, { sku: 'S1', id: 'id-S1', quantityInStock: 0 });
  prisma.db.stocks.push({ productId: 'id-S1', branchId: 'old', quantityInStock: 0 });
  const result = await importProductBatch({ prisma, products: rows(2), existingSkus: new Set(['S0', 'S1']), branchId: 'b1', userId: 'u1' });
  assert.deepEqual(result, { imported: 0, skipped: 2, errors: [] });
  assert.equal(prisma.db.products.length, 2);
  assert.deepEqual(prisma.db.stocks.find(s => s.productId === 'id-S0'), { productId: 'id-S0', branchId: 'b1', quantityInStock: 7, initialAllocation: 7 });
  assert.equal(prisma.db.stocks.filter(s => s.productId === 'id-S1').length, 1, 'products that already have stock are left alone');
});
