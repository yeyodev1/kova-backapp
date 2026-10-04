import { PipelineStage } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Product, toPublicProduct } from "../models/product.model";
import { escapeRegex } from "../utils/regex";

const SORTS: Record<string, Record<string, 1 | -1>> = {
  // Los agotados al final: nadie quiere ver primero lo que no puede comprar.
  popular: { inStock: -1, soldCount: -1, isFeatured: -1, createdAt: -1 },
  price_asc: { price: 1, createdAt: -1 },
  price_desc: { price: -1, createdAt: -1 },
  new: { createdAt: -1 },
};

export async function listPublic(query: {
  page?: unknown;
  limit?: unknown;
  category?: unknown;
  q?: unknown;
  featured?: unknown;
  sort?: unknown;
}) {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 24, 1), 60);

  const match: Record<string, unknown> = { isPublished: true };
  const category = String(query.category ?? "").trim();
  if (category) match.category = category;
  const q = String(query.q ?? "")
    .trim()
    .slice(0, 80);
  if (q) match.title = { $regex: escapeRegex(q), $options: "i" };
  if (query.featured === "1" || query.featured === "true") match.isFeatured = true;

  const sort = SORTS[String(query.sort ?? "popular")] || SORTS.popular;

  const pipeline: PipelineStage[] = [
    { $match: match },
    { $addFields: { inStock: { $cond: [{ $gt: ["$stock", 0] }, 1, 0] } } },
    { $sort: sort },
    { $skip: (page - 1) * limit },
    { $limit: limit },
    { $project: { inStock: 0 } },
  ];

  const [items, total] = await Promise.all([
    Product.aggregate(pipeline),
    Product.countDocuments(match),
  ]);

  return {
    items: items.map(toPublicProduct),
    total,
    page,
    pages: Math.max(Math.ceil(total / limit), 1),
  };
}

export async function categories(): Promise<string[]> {
  const list: string[] = await Product.distinct("category", { isPublished: true });
  return list.filter(Boolean).sort((a, b) => a.localeCompare(b, "es"));
}

export async function getBySlug(slug: string) {
  const product: any = await Product.findOne({
    slug: String(slug).toLowerCase(),
    isPublished: true,
  }).lean();
  if (!product) throw new CustomError("Producto no encontrado", 404);

  const related = product.category
    ? await Product.find({
        isPublished: true,
        category: product.category,
        _id: { $ne: product._id },
      })
        .sort({ stock: -1, soldCount: -1 })
        .limit(4)
        .lean()
    : [];

  return { ...toPublicProduct(product), related: related.map(toPublicProduct) };
}
