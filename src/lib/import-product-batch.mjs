const retryableCodes = new Set(['P2034', 'P2024', 'P2028', 'P1001', 'P1002', 'P1017']);
const failureReasons = {
  P2034: 'Database write conflict',
  P2024: 'Database connection wait timed out',
  P2028: 'Database transaction failed or timed out',
  P1001: 'Database is unreachable',
  P1002: 'Database connection timed out',
  P1017: 'Database connection was closed',
  P2002: 'A unique database value already exists',
  P2031: 'Database transactions require a MongoDB replica set',
};

async function withRetry(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 2 || !retryableCodes.has(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt + Math.random() * 100));
    }
  }
}

// Products saved by an interrupted bulk import can exist without their branch stock.
// Give any of these SKUs that have no stock record anywhere one in the import branch.
// Best-effort: a failure here is retried by the next import of the same file.
async function repairMissingStock(prisma, skus, branchId) {
  if (!skus.length) return;
  await withRetry(async () => {
    const orphans = await prisma.product.findMany({
      where: { sku: { in: skus }, branchStocks: { none: {} } },
      select: { id: true, quantityInStock: true },
    });
    if (orphans.length) {
      await prisma.productBranchStock.createMany({
        data: orphans.map(o => ({ productId: o.id, branchId, quantityInStock: o.quantityInStock, initialAllocation: o.quantityInStock })),
      });
    }
  }).catch(() => {});
}

// Fast path: a few bulk writes per batch instead of a transaction (5–7 round trips) per
// product, which made remote Atlas imports take ~0.5s per product. If a bulk write
// fails, the batch falls back to the per-product transactional import below, which
// skips anything the bulk step already saved and reports failures row by row.
export async function importProductBatch({ prisma, products, existingSkus, branchId, userId }) {
  const fresh = products.filter(p => !existingSkus.has(p.sku));
  const skippedExisting = products.length - fresh.length;

  await repairMissingStock(prisma, products.filter(p => existingSkus.has(p.sku)).map(p => p.sku), branchId);
  if (!fresh.length) return { imported: 0, skipped: skippedExisting, errors: [] };

  try {
    const categoryIds = new Map();
    for (const name of new Set(fresh.map(p => p.category))) {
      const cat = await withRetry(() => prisma.category.upsert({ where: { name }, update: {}, create: { name } }));
      categoryIds.set(name, cat.id);
    }

    await withRetry(() => prisma.product.createMany({
      data: fresh.map(({ rowNumber, category, ...data }) => ({ ...data, categoryId: categoryIds.get(category) })),
    }));
    const created = await withRetry(() => prisma.product.findMany({
      where: { sku: { in: fresh.map(p => p.sku) } }, select: { id: true, sku: true },
    }));
    const idBySku = new Map(created.map(p => [p.sku, p.id]));
    const saved = fresh.filter(p => idBySku.has(p.sku));

    await withRetry(() => prisma.productBranchStock.createMany({
      data: saved.map(p => ({ productId: idBySku.get(p.sku), branchId, quantityInStock: p.quantityInStock, initialAllocation: p.quantityInStock })),
    }));
    const stocked = saved.filter(p => p.quantityInStock > 0);
    if (stocked.length) {
      await withRetry(() => prisma.stockMovement.createMany({
        data: stocked.map(p => ({ productId: idBySku.get(p.sku), branchId, type: 'purchase', quantity: p.quantityInStock, notes: 'Opening stock from CSV import', userId })),
      }));
    }
    await withRetry(() => prisma.auditLog.createMany({
      data: saved.map(p => ({ userId, event: 'created', auditableType: 'Product', auditableId: idBySku.get(p.sku), newValues: { source: 'CSV import', sku: p.sku, branchId, stock: p.quantityInStock } })),
    })).catch(() => {}); // audit trail must not undo a completed import

    if (saved.length === fresh.length) return { imported: saved.length, skipped: skippedExisting, errors: [] };
  } catch (error) {
    console.error('Bulk product import failed; falling back to per-product import', error.code || error.name);
  }

  // Fallback: per-product transactions. SKUs the bulk step managed to save are skipped.
  const nowExisting = await prisma.product.findMany({ where: { sku: { in: fresh.map(p => p.sku) } }, select: { sku: true } })
    .then(rows => new Set(rows.map(r => r.sku))).catch(() => new Set());
  await repairMissingStock(prisma, [...nowExisting], branchId);
  const result = await importProductsTransactional({ prisma, products: fresh, existingSkus: nowExisting, branchId, userId });
  // Products saved by the bulk step count as imported by this run, not as skipped.
  return { imported: result.imported + nowExisting.size, skipped: skippedExisting + result.skipped - nowExisting.size, errors: result.errors };
}

// Bound database load while allowing independent product transactions to overlap.
export async function importProductsTransactional({ prisma, products, existingSkus, branchId, userId }) {
  const categories = new Map();
  function getCategory(name) {
    if (!categories.has(name)) {
      categories.set(name, withRetry(() => prisma.category.upsert({
        where: { name }, update: {}, create: { name },
      })).catch(async error => {
        // Another request may have created this category simultaneously.
        if (error.code !== 'P2002') throw error;
        const category = await prisma.category.findUnique({ where: { name } });
        if (!category) throw error;
        return category;
      }).catch(error => {
        categories.delete(name);
        throw error;
      }));
    }
    return categories.get(name);
  }

  let imported = 0, skipped = 0, next = 0;
  const errors = [];
  async function worker() {
    while (next < products.length) {
      const product = products[next++];
      if (existingSkus.has(product.sku)) { skipped++; continue; }
      const { rowNumber, category, ...data } = product;
      try {
        // Resolve each category once, outside concurrent product transactions.
        const cat = await getCategory(category);
        await withRetry(() => prisma.$transaction(async tx => {
          const created = await tx.product.create({ data: {
            ...data, categoryId: cat.id,
            branchStocks: { create: { branchId, quantityInStock: data.quantityInStock, initialAllocation: data.quantityInStock } },
            ...(data.quantityInStock > 0 ? { stockMovements: { create: { branchId, type: 'purchase', quantity: data.quantityInStock, notes: 'Opening stock from CSV import', userId } } } : {}),
          } });
          await tx.auditLog.create({ data: { userId, event: 'created', auditableType: 'Product', auditableId: created.id, newValues: { source: 'CSV import', sku: data.sku, branchId, stock: data.quantityInStock } } });
        }, { maxWait: 10000, timeout: 30000 }));
        imported++;
      } catch (error) {
        // A failed lookup must not abandon other workers or hide their results.
        const duplicate = await prisma.product.findUnique({ where: { sku: data.sku }, select: { id: true } }).catch(() => null);
        if (duplicate) skipped++;
        else {
          const code = /^P\d{4}$/.test(error.code || '') ? error.code : 'UNKNOWN';
          const reason = failureReasons[code] || 'Database save failed';
          console.error('Product import failed', { sku: data.sku, rowNumber, code });
          errors.push({ rowNumber, code, message: `Could not import SKU ${data.sku}: ${reason} (${code}). Retry this file; existing SKUs will be skipped.` });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, products.length) }, () => worker()));
  errors.sort((a, b) => a.rowNumber - b.rowNumber);
  return { imported, skipped, errors };
}
