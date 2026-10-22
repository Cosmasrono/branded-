This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

### Inventory CSV import

Open **Products → Import CSV**, select the opening-stock branch, and choose a CSV file.
Use **Check import** to review new products and existing SKUs, then **Import products**.
Excel workbooks must first be saved as **CSV UTF-8**. A template is available in the import dialog.

Required columns: `name`, `category`, `price`, `stock`, `sku`.
Optional columns: `costPrice`, `strength`, `dosageForm`, `packSize`, `requiresPrescription`, `description`.
Files may contain up to 5,000 products and 5 MB. Stock must be a non-negative whole number.
Existing SKUs (including inactive products) are skipped; new categories are created automatically.
Unsupported dosage forms are saved as `other`, with the original value added to the description.
Imports require `manage_products` permission. Products are sent in batches of 500 and each batch
is saved with a few bulk writes (products, opening stock, stock movements, audit entries), so a
remote Atlas import of ~3,700 products takes well under a minute. If a bulk write fails, that
batch falls back to saving products one by one in transactions. Keep the dialog open.
If interrupted, upload the same file again: products already saved are skipped, and any saved
without their stock record get one.

Run importer tests with
`node --test tests/product-import.test.mjs tests/import-product-batch.test.mjs tests/import-product-bulk.test.mjs`.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
