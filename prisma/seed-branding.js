// Add sample merchandise without changing existing inventory.
// Run: node --env-file=.env prisma/seed-branding.js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Illustrative test prices in KSh, not supplier quotations.
// [category, code, product, colours, sizes, cost, price, units per variant]
const ranges = [
  ["T-Shirts", "TEE", "Cotton Crew Neck T-Shirt", ["White", "Black", "Navy"], ["S", "M", "L", "XL", "XXL"], 350, 700, 20],
  ["T-Shirts", "VNECK", "V-Neck T-Shirt", ["White", "Black"], ["M", "L", "XL"], 400, 800, 15],
  ["Polo Shirts", "POLO", "Embroidered Polo Shirt", ["Navy", "White", "Red"], ["M", "L", "XL"], 700, 1400, 12],
  ["Jumpers", "JUMP", "Crew Neck Jumper", ["Grey", "Navy", "Black"], ["S", "M", "L", "XL"], 950, 1800, 10],
  ["Hoodies", "HOOD", "Pullover Hoodie", ["Black", "Grey", "Maroon"], ["M", "L", "XL"], 1200, 2300, 10],
  ["Hoodies", "ZIP", "Zip-Up Hoodie", ["Black", "Navy"], ["M", "L", "XL"], 1400, 2700, 8],
  ["Jackets", "JACKET", "Branded Softshell Jacket", ["Black", "Navy"], ["M", "L", "XL"], 2200, 3800, 6],
  ["Caps & Hats", "CAP", "Embroidered Baseball Cap", ["Black", "White", "Navy", "Red"], ["Adjustable"], 250, 600, 25],
  ["Caps & Hats", "BUCKET", "Cotton Bucket Hat", ["Black", "Beige"], ["One Size"], 350, 750, 15],
  ["Caps & Hats", "BEANIE", "Knitted Beanie", ["Black", "Grey"], ["One Size"], 250, 550, 15],
  ["Bags", "TOTE", "Printed Canvas Tote Bag", ["Natural", "Black"], ["Standard"], 300, 700, 25],
  ["Bags", "DRAW", "Drawstring Bag", ["Blue", "Black"], ["Standard"], 200, 450, 25],
  ["Bags", "PACK", "Logo Backpack", ["Black", "Grey"], ["20L"], 1200, 2500, 8],
  ["Drinkware", "MUG", "Printed Ceramic Mug", ["White", "Black"], ["330ml"], 180, 450, 30],
  ["Drinkware", "BOTTLE", "Stainless Steel Water Bottle", ["Silver", "Black"], ["750ml"], 550, 1200, 15],
  ["Drinkware", "TUMBLER", "Insulated Travel Tumbler", ["Black", "White"], ["500ml"], 700, 1500, 12],
  ["Workwear", "APRON", "Embroidered Apron", ["Black", "Navy"], ["Adjustable"], 450, 950, 12],
  ["Workwear", "VEST", "Reflective Safety Vest", ["Yellow", "Orange"], ["L", "XL"], 300, 650, 15],
  ["Promotional Gifts", "LANYARD", "Printed Lanyard", ["Blue", "Red", "Black"], ["20mm"], 50, 150, 50],
  ["Promotional Gifts", "PEN", "Logo Ballpoint Pen", ["Blue", "Black"], ["Standard"], 25, 80, 100],
  ["Promotional Gifts", "BOOK", "Branded Notebook", ["Black", "Navy"], ["A5"], 250, 600, 20],
  ["Promotional Gifts", "KEY", "Engraved Metal Keyring", ["Silver"], ["Standard"], 100, 300, 40],
  ["Promotional Gifts", "UMBRELLA", "Branded Golf Umbrella", ["Black", "Navy"], ["Large"], 650, 1400, 10],
];

async function main() {
  let branch = await prisma.branch.findFirst({ where: { isActive: true }, orderBy: [{ isMain: "desc" }, { name: "asc" }] });
  const admins = String(process.env.adminEmail || "").split(/[,;\s]+/).filter(Boolean).map((email) => email.toLowerCase());
  const actor = await prisma.user.findFirst({ where: { isActive: true, email: { in: admins } } });
  if (!actor) throw new Error("NO_ACTIVE_CONFIGURED_ADMIN");
  if (!branch) {
    if (await prisma.branch.count()) throw new Error("NO_ACTIVE_BRANCH");
    branch = await prisma.branch.create({ data: { name: "Main Branch", code: "MAIN", isMain: true, isActive: true, stockDistributionPercentage: 100 } });
  }
  let created = 0;
  let skipped = 0;
  const skus = [];
  for (const [categoryName, code, title, colours, sizes, costPrice, sellingPrice, quantity] of ranges) {
    const category = await prisma.category.upsert({ where: { name: categoryName }, update: {}, create: { name: categoryName, description: "Branding and custom merchandise" } });
    for (const colour of colours) for (const size of sizes) {
      const sku = `DEMO-BRAND-${code}-${colour}-${size}`.toUpperCase().replace(/\s+/g, "-");
      skus.push(sku);
      if (await prisma.product.findUnique({ where: { sku }, select: { id: true } })) { skipped++; continue; }
      await prisma.$transaction(async (tx) => {
        const product = await tx.product.create({ data: {
          name: `${title} - ${colour} / ${size}`, sku, categoryId: category.id,
          description: `Sample branding merchandise for testing. Colour: ${colour}. Size: ${size}. Illustrative KSh pricing.`,
          costPrice, sellingPrice, quantityInStock: quantity, totalCost: costPrice * quantity,
          reorderLevel: 5, isActive: true,
          branchStocks: { create: { branchId: branch.id, quantityInStock: quantity, initialAllocation: quantity } },
        } });
        await tx.stockMovement.create({ data: { productId: product.id, branchId: branch.id, userId: actor.id, type: "purchase", quantity, notes: "Opening stock: branding demo inventory" } });
      });
      created++;
    }
  }
  const products = await prisma.product.findMany({ where: { sku: { in: skus } }, include: { branchStocks: true } });
  if (products.length !== skus.length || products.some((p) => p.quantityInStock !== p.branchStocks.reduce((sum, s) => sum + s.quantityInStock, 0))) throw new Error("STOCK_VERIFICATION_FAILED");
  console.log(JSON.stringify({ created, skipped, verified: products.length, categories: new Set(ranges.map((r) => r[0])).size, branch: branch.name, totalUnits: products.reduce((sum, p) => sum + p.quantityInStock, 0) }));
}

main().catch((error) => {
  // Avoid printing connection strings or credentials from database errors.
  console.error("Branding seed failed:", error.code || (error.message.match(/^[A-Z_]+$/) ? error.message : "DATABASE_ERROR"));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
