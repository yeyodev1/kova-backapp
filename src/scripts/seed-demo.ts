/**
 * Productos y ubicaciones de demostración para diseñar el frontend sin Dropi.
 * Solo corre contra una base cuyo nombre termine en "-dev": nunca toca producción.
 * Uso: DB_URI=<uri a kova-dev> pnpm seed:demo
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env";
import { Product } from "../models/product.model";
import { Location } from "../models/location.model";

const IMG = "https://cdn.dummyjson.com/product-images";

interface Demo {
  title: string;
  category: string;
  price: number;
  compareAt: number;
  stock: number;
  sold: number;
  featured: boolean;
  images: string[];
  short: string;
  benefits: string[];
  variants?: { name: string; color: string }[];
}

const demos: Demo[] = [
  {
    title: "Audífonos inalámbricos con estuche de carga",
    category: "Tecnología",
    price: 2490,
    compareAt: 3990,
    stock: 38,
    sold: 214,
    featured: true,
    images: [1, 2, 3].map((n) => `${IMG}/mobile-accessories/apple-airpods/${n}.webp`),
    short: "Sonido limpio, conexión al instante y hasta 20 horas con el estuche.",
    benefits: [
      "Se conectan solos al abrir el estuche",
      "Hasta 20 horas de batería con el estuche",
      "Micrófono para llamadas en la calle",
      "Resistentes al sudor",
    ],
  },
  {
    title: "Cargador inalámbrico rápido 3 en 1",
    category: "Tecnología",
    price: 1990,
    compareAt: 2990,
    stock: 7,
    sold: 96,
    featured: true,
    images: [`${IMG}/mobile-accessories/apple-airpower-wireless-charger/1.webp`],
    short: "Carga celular, audífonos y reloj al mismo tiempo, sin cables enredados.",
    benefits: ["Carga 3 dispositivos a la vez", "Base antideslizante", "Protección contra sobrecalentamiento"],
  },
  {
    title: "Parlante inteligente con luz ambiental",
    category: "Tecnología",
    price: 3490,
    compareAt: 4990,
    stock: 22,
    sold: 58,
    featured: true,
    images: [1, 2].map((n) => `${IMG}/mobile-accessories/amazon-echo-plus/${n}.webp`),
    short: "Música en toda la sala y una luz cálida para la noche.",
    benefits: ["Bluetooth 5.0", "Luz LED regulable", "Batería para 8 horas"],
    variants: [
      { name: "Negro", color: "Negro" },
      { name: "Gris", color: "Gris" },
    ],
  },
  {
    title: "Licuadora portátil recargable",
    category: "Cocina",
    price: 2290,
    compareAt: 3490,
    stock: 45,
    sold: 341,
    featured: true,
    images: [1, 2, 3, 4].map((n) => `${IMG}/kitchen-accessories/boxed-blender/${n}.webp`),
    short: "Batidos en 30 segundos donde estés. Se carga con USB.",
    benefits: ["Carga USB-C", "6 cuchillas de acero", "Vaso libre de BPA", "Cabe en la mochila"],
  },
  {
    title: "Taza térmica de aluminio",
    category: "Cocina",
    price: 990,
    compareAt: 1490,
    stock: 60,
    sold: 128,
    featured: false,
    images: [1, 2].map((n) => `${IMG}/kitchen-accessories/black-aluminium-cup/${n}.webp`),
    short: "Tu café caliente por 6 horas y frío por 12.",
    benefits: ["Doble pared al vacío", "Tapa antiderrames", "Fácil de lavar"],
  },
  {
    title: "Batidor de acero inoxidable",
    category: "Cocina",
    price: 690,
    compareAt: 0,
    stock: 0,
    sold: 12,
    featured: false,
    images: [`${IMG}/kitchen-accessories/black-whisk/1.webp`],
    short: "Mezcla sin grumos con varillas de acero flexibles.",
    benefits: ["Acero inoxidable", "Mango ergonómico"],
  },
  {
    title: "Maceta decorativa minimalista",
    category: "Hogar",
    price: 1290,
    compareAt: 1890,
    stock: 18,
    sold: 44,
    featured: false,
    images: [1, 2, 3, 4].map((n) => `${IMG}/home-decoration/plant-pot/${n}.webp`),
    short: "Le da vida a cualquier rincón. Incluye plato para el agua.",
    benefits: ["Cerámica resistente", "Plato incluido", "Acabado mate"],
    variants: [
      { name: "Pequeña", color: "Pequeña" },
      { name: "Mediana", color: "Mediana" },
    ],
  },
  {
    title: "Planta artificial decorativa",
    category: "Hogar",
    price: 1790,
    compareAt: 2490,
    stock: 9,
    sold: 31,
    featured: false,
    images: [1, 2, 3].map((n) => `${IMG}/home-decoration/house-showpiece-plant/${n}.webp`),
    short: "Verde todo el año, sin regar ni cuidar.",
    benefits: ["No necesita agua ni luz", "Hojas realistas", "Base estable"],
  },
];

function slugify(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function offersFor(price: number) {
  const round = (cents: number) => Math.round(cents / 10) * 10;
  return [
    { quantity: 1, unitPrice: price, label: "", isDefault: true },
    { quantity: 2, unitPrice: round(price * 0.9), label: "Más vendido", isDefault: false },
    { quantity: 3, unitPrice: round(price * 0.85), label: "Mejor precio", isDefault: false },
  ];
}

const PROVINCES: Record<string, string[]> = {
  Guayas: ["Guayaquil", "Durán", "Samborondón", "Daule", "Milagro"],
  Pichincha: ["Quito", "Sangolquí", "Cayambe"],
  Azuay: ["Cuenca", "Gualaceo"],
  Manabí: ["Manta", "Portoviejo", "Chone"],
  "El Oro": ["Machala", "Pasaje"],
};

async function main() {
  const dbName = new URL(env.DB_URI.replace("mongodb+srv://", "https://")).pathname.slice(1);
  if (!dbName.endsWith("-dev")) {
    console.error(`✖ seed:demo solo corre en una base "-dev" (actual: "${dbName || "test"}")`);
    process.exit(1);
  }

  await mongoose.connect(env.DB_URI);

  for (const demo of demos) {
    const slug = slugify(demo.title);
    const variants = (demo.variants ?? []).map((v, i) => ({
      name: v.name,
      attributes: { Opción: v.color },
      price: demo.price,
      compareAtPrice: demo.compareAt,
      stock: i === 0 ? demo.stock : Math.max(0, demo.stock - 5),
      sku: `${slug}-${i}`,
    }));
    await Product.findOneAndUpdate(
      { slug },
      {
        slug,
        title: demo.title,
        shortDescription: demo.short,
        description: `<p>${demo.short}</p><p>Producto de demostración para diseñar la tienda.</p>`,
        images: demo.images,
        category: demo.category,
        price: demo.price,
        compareAtPrice: demo.compareAt,
        type: variants.length ? "VARIABLE" : "SIMPLE",
        variants,
        offers: offersFor(demo.price),
        benefits: demo.benefits,
        faqs: [
          { question: "¿Cuánto tarda el envío?", answer: "De 1 a 3 días hábiles en ciudades principales." },
          { question: "¿Puedo pagar al recibir?", answer: "Sí, con un pequeño recargo que ves antes de confirmar." },
        ],
        stock: demo.stock,
        isPublished: true,
        isFeatured: demo.featured,
        soldCount: demo.sold,
        costPrice: Math.round(demo.price * 0.45),
        suggestedPrice: demo.price,
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    console.log(`✔ ${demo.title}`);
  }

  let pid = 1;
  let cid = 100;
  for (const [province, cities] of Object.entries(PROVINCES)) {
    const provinceId = pid++;
    await Location.findOneAndUpdate(
      { kind: "province", dropiId: provinceId },
      { kind: "province", dropiId: provinceId, name: province },
      { upsert: true },
    );
    for (const city of cities) {
      const cityId = cid++;
      await Location.findOneAndUpdate(
        { kind: "city", dropiId: cityId },
        { kind: "city", dropiId: cityId, name: city, provinceId },
        { upsert: true },
      );
    }
  }
  console.log("✔ Provincias y ciudades de demostración");

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
