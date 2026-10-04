import { normalize } from "./intents";

/**
 * Ciudad y provincia del cliente contra las ubicaciones de Dropi (colección
 * Location). Función pura: `deps.ts` carga la lista y las pruebas usan una fija.
 * Un nombre mal escrito hace que Dropi rechace el pedido, por eso nunca se
 * adivina: si hay dudas se pregunta.
 */

export interface LocationIndex {
  provinces: Array<{ id: number; name: string }>;
  cities: Array<{ id: number; name: string; provinceId: number }>;
}

export interface Place {
  provinceId: number;
  province: string;
  cityId: number;
  city: string;
}

export type LocationMatch =
  | { status: "ok"; place: Place }
  | { status: "ambiguous"; options: Place[] }
  | { status: "province_only"; provinceId: number; province: string }
  | { status: "not_found" };

/** "GUAYAQUIL" -> "Guayaquil", "SANTO DOMINGO DE LOS TSACHILAS" -> "Santo Domingo de los Tsachilas". */
export function prettyName(name: string) {
  const small = new Set(["de", "del", "la", "las", "los", "y", "el"]);
  return String(name || "")
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) =>
      index > 0 && small.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

const contains = (haystack: string, needle: string) =>
  Boolean(needle) && ` ${haystack} `.includes(` ${needle} `);

/** Nombres alternos que la gente escribe y Dropi no usa. */
const ALIASES: Record<string, string> = {
  gye: "guayaquil",
  uio: "quito",
  "santo domingo": "santo domingo",
  samborondon: "samborondon",
};

function placeOf(index: LocationIndex, city: LocationIndex["cities"][number]): Place {
  const province = index.provinces.find((p) => p.id === city.provinceId);
  return {
    provinceId: city.provinceId,
    province: prettyName(province?.name || ""),
    cityId: city.id,
    city: prettyName(city.name),
  };
}

/**
 * `withinProvinceId`: el cliente ya dijo la provincia y ahora escribe la ciudad.
 */
export function matchLocation(
  text: string,
  index: LocationIndex,
  withinProvinceId = 0,
): LocationMatch {
  let value = normalize(text)
    .replace(/[.,;:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [alias, real] of Object.entries(ALIASES)) {
    if (contains(value, alias)) value = `${value} ${real}`;
  }
  if (!value) return { status: "not_found" };

  const provinces = index.provinces.filter((p) => contains(value, normalize(p.name)));
  const provinceIds = new Set(withinProvinceId ? [withinProvinceId] : provinces.map((p) => p.id));

  // Ciudades nombradas, la más larga primero ("Santo Domingo" gana a "Domingo").
  let cities = index.cities
    .filter((c) => contains(value, normalize(c.name)))
    .filter((c) => !withinProvinceId || c.provinceId === withinProvinceId);
  const longest = Math.max(0, ...cities.map((c) => normalize(c.name).length));
  cities = cities.filter((c) => normalize(c.name).length === longest);

  // Si nombró ciudad y provincia, la provincia desempata.
  if (cities.length > 1 && provinceIds.size) {
    const inProvince = cities.filter((c) => provinceIds.has(c.provinceId));
    if (inProvince.length) cities = inProvince;
  }
  // "Guayaquil, Guayas": la ciudad que se llama igual que una provincia no es otra.
  if (cities.length === 1) return { status: "ok", place: placeOf(index, cities[0]) };
  if (cities.length > 1)
    return { status: "ambiguous", options: cities.slice(0, 6).map((c) => placeOf(index, c)) };

  if (provinces.length === 1 || withinProvinceId) {
    const province = withinProvinceId
      ? index.provinces.find((p) => p.id === withinProvinceId)
      : provinces[0];
    if (province) {
      // La capital suele llamarse distinto; solo se pide la ciudad.
      return {
        status: "province_only",
        provinceId: province.id,
        province: prettyName(province.name),
      };
    }
  }
  return { status: "not_found" };
}

export const placeText = (place: { city: string; province: string }) =>
  place.province && place.province !== place.city ? `${place.city}, ${place.province}` : place.city;
