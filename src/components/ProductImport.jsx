"use client";

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui';

// Products per request; the server saves each batch with a few bulk writes.
const BATCH = 500;
import { parseProductCsv, validateProductRows, MAX_IMPORT_BYTES } from '@/lib/product-import.mjs';

export default function ProductImport({ onClose, onImported }) {
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');
  const [rows, setRows] = useState([]);
  const [products, setProducts] = useState([]);
  const [errors, setErrors] = useState([]);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetch('/api/branches').then(async res => {
      if (!res.ok) throw new Error('Could not load branches. Close and try again.');
      const data = await res.json();
      const active = data.data.filter(b => b.isActive);
      setBranches(active);
      setBranchId((active.find(b => b.isMain) || active[0])?.id || '');
    }).catch(e => setMessage(e.message));
  }, []);

  async function selectFile(event) {
    const file = event.target.files?.[0];
    setRows([]); setProducts([]); setErrors([]); setPreview(null); setMessage(''); setResult(null); setProgress('');
    if (!file) return;
    setBusy(true);
    try {
      if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('Choose a CSV file. In Excel, save as CSV UTF-8 first.');
      if (file.size > MAX_IMPORT_BYTES) throw new Error('Maximum file size is 5 MB.');
      const parsed = parseProductCsv(await file.text());
      const validated = validateProductRows(parsed);
      setRows(parsed); setProducts(validated.products); setErrors(validated.errors);
    } catch (e) { setMessage(e.message); }
    finally { setBusy(false); }
  }

  async function request(payload) {
    const response = await fetch('/api/products/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) {
      if (data.errors) setErrors(data.errors);
      throw new Error(data.message || 'Import request failed.');
    }
    return data;
  }

  async function check() {
    setBusy(true); setMessage(''); setResult(null); setErrors([]);
    try { setPreview(await request({ rows, branchId, preview: true })); }
    catch (e) { setMessage(e.message); }
    finally { setBusy(false); }
  }

  async function importProducts() {
    setBusy(true); setMessage(''); setErrors([]);
    const totals = { imported: 0, skipped: 0, errors: [] };
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        setProgress(`Processing ${i + 1}–${Math.min(i + BATCH, rows.length)} of ${rows.length} products… Keep this window open.`);
        const data = await request({ rows: rows.slice(i, i + BATCH), branchId });
        totals.imported += data.imported;
        totals.skipped += data.skipped;
        totals.errors.push(...data.errors);
        if (data.errors.length) {
          setMessage('Import paused because some products could not be saved. Check the errors below, then click Check import to retry. Products already saved will be skipped.');
          break;
        }
      }
    } catch (e) { setMessage(`${e.message} You can safely retry the file; existing SKUs are skipped.`); }
    finally {
      setResult(totals); setErrors(totals.errors); setProgress(''); setPreview(null); setBusy(false); onImported();
    }
  }

  return (
    <Modal title="Import products from CSV" onClose={() => { if (!busy) onClose(); }} wide>
      <div className="space-y-4 text-sm">
        <p>Upload a CSV (up to 5 MB / 5,000 products). In Excel, use <strong>Save As → CSV UTF-8</strong>.</p>
        <a className="text-teal-700 underline" href="/product-import-template.csv" download>Download CSV template</a>
        <p>New categories are created automatically. Existing SKUs, including inactive products, are skipped without changing their stock or prices. All opening stock goes to your selected branch.</p>
        <p className="text-slate-500">Device, Spray and other unsupported dosage forms are saved as Other; their original value is kept in the description.</p>
        <label className="block">Opening stock branch
          <select className="input w-full mt-1" value={branchId} disabled={busy} onChange={e => { setBranchId(e.target.value); setPreview(null); }}>
            <option value="">Select a branch</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="block">Product file
          <input className="block mt-1 w-full" type="file" accept=".csv,text/csv" disabled={busy} onChange={selectFile} />
        </label>
        {message && <p role="alert" className="text-rose-700">{message}</p>}
        {!!errors.length && <div role="alert" className="max-h-40 overflow-auto text-rose-700">
          <p>{errors.length} error(s). {result ? 'These products could not be saved. Check the reason below before retrying.' : 'Fix these rows before importing.'}</p>
          <ul className="list-disc pl-5">{errors.slice(0, 100).map((e, i) => <li key={i}>Row {e.rowNumber}: {e.message}</li>)}</ul>
          {errors.length > 100 && <p>Showing the first 100 errors.</p>}
        </div>}
        {products.length > 0 && <div className="overflow-x-auto">
          <p className="mb-2">{rows.length} product rows. Preview of the first 5 valid rows:</p>
          <table className="w-full"><thead><tr><th className="table-th">Product</th><th className="table-th">SKU</th><th className="table-th">Price (KSh)</th><th className="table-th">Stock</th></tr></thead>
            <tbody>{products.slice(0, 5).map(p => <tr key={p.rowNumber}><td className="table-td">{p.name}</td><td className="table-td">{p.sku}</td><td className="table-td">{p.sellingPrice}</td><td className="table-td">{p.quantityInStock}</td></tr>)}</tbody>
          </table>
        </div>}
        {preview && <p className="rounded bg-sky-50 p-3">{rows.length - preview.existingSkus.length} new products will be imported; {preview.existingSkus.length} existing SKUs will be skipped.</p>}
        {progress && <p role="status">{progress}</p>}
        {result && <p role="status">Confirmed: {result.imported} imported, {result.skipped} skipped, {result.errors.length} failed.</p>}
        <div className="flex gap-2 justify-end">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>Close</button>
          {preview ? <button className="btn-primary" disabled={busy || rows.length === preview.existingSkus.length} onClick={importProducts}>{busy ? 'Importing…' : 'Import products'}</button>
            : <button className="btn-primary" disabled={busy || !rows.length || (!!errors.length && !result) || !branchId} onClick={check}>{busy ? 'Checking…' : 'Check import'}</button>}
        </div>
      </div>
    </Modal>
  );
}
