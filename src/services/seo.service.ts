import { Product } from "../models/product.model";

// El sitemap siempre apunta al dominio público, aunque el API corra en local o en un preview.
const SITE_URL = "https://kovashopper.com";

// Mismos slugs que `policies` en kova-frontapp/src/config/site.ts.
const STATIC_PATHS = [
  { path: "/", changefreq: "daily", priority: "1.0" },
  { path: "/tienda", changefreq: "daily", priority: "0.9" },
  { path: "/rastrear", changefreq: "monthly", priority: "0.3" },
  { path: "/politicas/envios", changefreq: "yearly", priority: "0.2" },
  { path: "/politicas/devoluciones", changefreq: "yearly", priority: "0.2" },
  { path: "/politicas/privacidad", changefreq: "yearly", priority: "0.2" },
  { path: "/politicas/terminos", changefreq: "yearly", priority: "0.2" },
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function urlEntry(loc: string, extra: { lastmod?: Date; changefreq?: string; priority?: string }) {
  const lines = [`    <loc>${escapeXml(loc)}</loc>`];
  if (extra.lastmod) lines.push(`    <lastmod>${extra.lastmod.toISOString()}</lastmod>`);
  if (extra.changefreq) lines.push(`    <changefreq>${extra.changefreq}</changefreq>`);
  if (extra.priority) lines.push(`    <priority>${extra.priority}</priority>`);
  return `  <url>\n${lines.join("\n")}\n  </url>`;
}

/** Sitemap XML con las páginas fijas de la tienda y cada producto publicado. */
export async function sitemap(): Promise<string> {
  const products = await Product.find({ isPublished: true }, { slug: 1, updatedAt: 1 })
    .sort({ updatedAt: -1 })
    .lean<{ slug: string; updatedAt?: Date }[]>();

  const entries = [
    ...STATIC_PATHS.map((p) => urlEntry(`${SITE_URL}${p.path}`, p)),
    ...products.map((p) =>
      urlEntry(`${SITE_URL}/producto/${encodeURIComponent(p.slug)}`, {
        lastmod: p.updatedAt ? new Date(p.updatedAt) : undefined,
        changefreq: "weekly",
        priority: "0.8",
      }),
    ),
  ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");
}
