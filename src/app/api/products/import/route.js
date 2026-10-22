import prisma from '@/lib/prisma';
import { importProductBatch } from '@/lib/import-product-batch.mjs';
import { requireAuth } from '@/lib/auth';
import { validateProductRows, MAX_IMPORT_BYTES } from '@/lib/product-import.mjs';

export async function POST(req) {
  const { user, error } = await requireAuth('manage_products');
  if (error) return error;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_IMPORT_BYTES * 2) return Response.json({ message: 'Import request is too large.' }, { status: 413 });
    let body;
    try { body = JSON.parse(text); } catch { return Response.json({ message: 'Invalid import request.' }, { status: 400 }); }
    const { rows, branchId, preview } = body;
    if (!preview && (!Array.isArray(rows) || rows.length > 500)) return Response.json({ message: 'Import at most 500 products per batch.' }, { status: 422 });
    let validated;
    try { validated = validateProductRows(rows); } catch (e) { return Response.json({ message: e.message }, { status: 422 }); }
    if (validated.errors.length) return Response.json({ message: 'Fix the CSV errors before importing.', errors: validated.errors }, { status: 422 });
    if (typeof branchId !== 'string' || !/^[a-f0-9]{24}$/i.test(branchId)) return Response.json({ message: 'Select an active branch.' }, { status: 422 });
    const branch = await prisma.branch.findFirst({ where: { id: branchId, isActive: true } });
    if (!branch) return Response.json({ message: 'The selected branch is inactive or missing.' }, { status: 422 });
    const existing = await prisma.product.findMany({ where: { sku: { in: validated.products.map(p => p.sku) } }, select: { sku: true } });
    const existingSkus = new Set(existing.map(p => p.sku));
    if (preview) return Response.json({ existingSkus: [...existingSkus] });

    const result = await importProductBatch({ prisma, products: validated.products, existingSkus, branchId, userId: user.id });
    return Response.json(result);
  } catch (e) {
    console.error('Import request failed', e.code || e.name);
    return Response.json({ message: 'Import could not finish. Retry the file; existing SKUs will be skipped.' }, { status: 500 });
  }
}

