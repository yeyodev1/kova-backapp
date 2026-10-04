/**
 * Bancos y cooperativas de Ecuador que el panel ofrece al cargar una cuenta.
 * El logo sale del servicio de íconos de Google por dominio (sin API key). Los
 * que no tienen ícono ahí quedan sin dominio y el panel muestra un ícono genérico.
 */
export interface BankInfo {
  code: string;
  name: string;
  domain: string;
  /** Palabras que solo pueden referirse al banco. */
  keywords: string[];
  /**
   * Nombres que también son ciudad o provincia ("Pichincha", "Guayaquil"): solo
   * cuentan como banco si se está eligiendo banco o el cliente habla de pagar.
   */
  placeWords?: string[];
}

export const BANKS: BankInfo[] = [
  { code: "pichincha", name: "Banco Pichincha", domain: "pichincha.com", keywords: ["banco pichincha"], placeWords: ["pichincha"] },
  { code: "deuna", name: "Deuna (Banco Pichincha)", domain: "deuna.app", keywords: ["deuna"] },
  { code: "guayaquil", name: "Banco Guayaquil", domain: "bancoguayaquil.com", keywords: ["banco guayaquil", "banco de guayaquil", "bg"], placeWords: ["guayaquil"] },
  { code: "barrio", name: "Banco del Barrio (Guayaquil)", domain: "", keywords: ["banco del barrio"] },
  // Google no tiene ícono de bancodelpacifico.com: el de su banca en línea sí.
  { code: "pacifico", name: "Banco del Pacífico", domain: "intermatico.com", keywords: ["pacifico", "intermatico"] },
  { code: "produbanco", name: "Produbanco", domain: "produbanco.com.ec", keywords: ["produbanco", "produ"] },
  { code: "bolivariano", name: "Banco Bolivariano", domain: "bolivariano.com", keywords: ["bolivariano"] },
  { code: "internacional", name: "Banco Internacional", domain: "bancointernacional.com.ec", keywords: ["banco internacional"], placeWords: ["internacional"] },
  { code: "austro", name: "Banco del Austro", domain: "www.bancodelaustro.com", keywords: ["austro"] },
  { code: "machala", name: "Banco de Machala", domain: "bancomachala.com", keywords: ["banco de machala", "banco machala"], placeWords: ["machala"] },
  { code: "loja", name: "Banco de Loja", domain: "bancodeloja.com", keywords: ["banco de loja", "banco loja"], placeWords: ["loja"] },
  { code: "bgr", name: "Banco General Rumiñahui", domain: "bgr.com.ec", keywords: ["bgr", "rumiñahui", "ruminahui"] },
  { code: "diners", name: "Diners Club", domain: "dinersclub.com.ec", keywords: ["diners"] },
  { code: "procredit", name: "Banco ProCredit", domain: "bancoprocredit.com.ec", keywords: ["procredit"] },
  { code: "solidario", name: "Banco Solidario", domain: "", keywords: ["solidario"] },
  { code: "bancodesarrollo", name: "Banco Desarrollo", domain: "", keywords: ["bancodesarrollo", "banco desarrollo"] },
  { code: "banecuador", name: "BanEcuador", domain: "", keywords: ["banecuador", "ban ecuador"] },
  { code: "jep", name: "Cooperativa JEP", domain: "coopjep.fin.ec", keywords: ["jep"] },
  { code: "jardin-azuayo", name: "Cooperativa Jardín Azuayo", domain: "", keywords: ["jardin azuayo"] },
  { code: "29-octubre", name: "Cooperativa 29 de Octubre", domain: "29deoctubre.fin.ec", keywords: ["29 de octubre"] },
  { code: "policia", name: "Cooperativa Policía Nacional", domain: "cpn.fin.ec", keywords: ["policia nacional", "cpn"] },
  { code: "alianza", name: "Cooperativa Alianza del Valle", domain: "www.alianzadelvalle.fin.ec", keywords: ["alianza del valle"] },
  { code: "progreso", name: "Cooperativa Progreso", domain: "cooprogreso.fin.ec", keywords: ["cooprogreso", "cooperativa progreso"] },
  { code: "andalucia", name: "Cooperativa Andalucía", domain: "andalucia.fin.ec", keywords: ["andalucia"] },
  { code: "mushuc-runa", name: "Cooperativa Mushuc Runa", domain: "", keywords: ["mushuc runa"] },
];

export const OTHER_BANK = "otro";

export const findBank = (code: string): BankInfo | undefined =>
  BANKS.find((bank) => bank.code === code);

export function bankLogo(code: string): string {
  const domain = findBank(code)?.domain;
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : "";
}

/** Catálogo para el panel: lo que hace falta para el selector con logos. */
export const bankCatalog = () =>
  BANKS.map(({ code, name }) => ({ code, name, logoUrl: bankLogo(code) })).concat({
    code: OTHER_BANK,
    name: "Otro banco o cooperativa",
    logoUrl: "",
  });

const normalize = (text: string) =>
  String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "te pago por", "transfiero al", "deposito en": el cliente habla de pagar, no de su dirección. */
const PAY_CONTEXT = /\b(pago|pagar|pagaria|transfiero|transferir|transferencia|deposito|depositar|banco|cuenta)\b/;

interface BankLike {
  bank: string;
  bankCode?: string;
}

function wordsFor(account: BankLike, loose: boolean): string[] {
  const known = account.bankCode ? findBank(account.bankCode) : undefined;
  if (!known) {
    // Cuenta de "otro banco": su nombre sin "banco"/"cooperativa" delante.
    const name = normalize(account.bank).replace(/^(banco|cooperativa|coop) (del |de la |de )?/, "");
    return name.length > 2 ? [name] : [];
  }
  const words = known.keywords.map(normalize);
  if (loose && known.placeWords) words.push(...known.placeWords.map(normalize));
  return words;
}

/**
 * Cuenta que nombra el cliente ("te pago por Pichincha"), solo entre las que
 * recibe. Con `choosing` (se le preguntó el banco) también cuentan nombres que
 * son ciudad; si no, solo cuando habla de pagar: "Quito, Pichincha" en una
 * dirección no es un banco.
 */
export function bankFromText<T extends BankLike>(
  text: string,
  accounts: T[],
  choosing = false,
): T | null {
  const value = ` ${normalize(text)} `;
  const loose = choosing || PAY_CONTEXT.test(value);
  for (const account of accounts) {
    if (wordsFor(account, loose).some((word) => word && value.includes(` ${word} `))) return account;
  }
  return null;
}

/** Código del catálogo para un nombre escrito a mano ("Pichincha ahorros" → pichincha). */
export function guessBankCode(name: string): string {
  const value = ` ${normalize(name)} `;
  // La coincidencia más larga gana: "Banco del Barrio (Guayaquil)" es Barrio, no Guayaquil.
  let best = { code: OTHER_BANK, length: 0 };
  for (const bank of BANKS) {
    for (const word of [...bank.keywords, ...(bank.placeWords || [])].map(normalize)) {
      if (word.length > best.length && value.includes(` ${word} `)) best = { code: bank.code, length: word.length };
    }
  }
  return best.code;
}
