import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import {
  activeBankAccounts,
  BANK_ACCOUNT_TYPES,
  getSettings,
  IBankAccount,
  ISettings,
  Setting,
} from "../models/setting.model";
import { bankCatalog, bankLogo, findBank, OTHER_BANK } from "./banks";

const MAX_ACCOUNTS = 10;
const NEEDS_ACCOUNT = "Para aceptar transferencias agrega al menos una cuenta activa";
const LAST_ACTIVE =
  "Es la única cuenta activa y las transferencias están encendidas. Apaga primero \"Aceptar transferencias\" o activa otra cuenta";

/** Cuenta tal como la ve el panel: el logo siempre resuelto. */
function present(account: IBankAccount) {
  return {
    _id: String(account._id),
    bank: account.bank,
    bankCode: account.bankCode || OTHER_BANK,
    type: account.type,
    number: account.number,
    holder: account.holder,
    idNumber: account.idNumber,
    active: account.active !== false,
    logoUrl: account.logoUrl || bankLogo(account.bankCode || ""),
  };
}

/** Lo que reciben la web y los correos: solo cuentas activas y sin estado interno. */
export function publicAccount(account: IBankAccount) {
  const { active, ...rest } = present(account);
  return rest;
}

function paymentsView(settings: ISettings) {
  return {
    acceptTransfers: Boolean(settings.acceptTransfers),
    transferSurcharge: settings.transferSurcharge || 0,
    accounts: (settings.bankAccounts || []).map(present),
    banks: bankCatalog(),
  };
}

export async function getPayments() {
  return paymentsView(await getSettings());
}

export async function updatePayments(body: any) {
  const input = body ?? {};
  const settings = await getSettings();
  const update: Record<string, unknown> = {};

  if (input.acceptTransfers !== undefined) {
    const accept = input.acceptTransfers === true || input.acceptTransfers === "true";
    if (accept && !activeBankAccounts(settings).length) throw new CustomError(NEEDS_ACCOUNT, 400);
    update.acceptTransfers = accept;
  }
  if (input.transferSurcharge !== undefined) {
    const cents = Number(input.transferSurcharge);
    if (!Number.isInteger(cents) || cents < 0) {
      throw new CustomError("El recargo por transferencia debe ser un monto mayor o igual a cero", 400);
    }
    update.transferSurcharge = cents;
  }

  await Setting.updateOne({ key: "main" }, { $set: update });
  return getPayments();
}

const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");

/** Valida y limpia los datos de una cuenta. `partial` deja fuera lo que no venga. */
function parseAccount(input: any, current?: IBankAccount): IBankAccount {
  const value = <K extends keyof IBankAccount>(key: K) =>
    input?.[key] !== undefined ? input[key] : current?.[key];

  const bankCode = String(value("bankCode") ?? OTHER_BANK).trim() || OTHER_BANK;
  const known = findBank(bankCode);
  if (!known && bankCode !== OTHER_BANK) throw new CustomError("Elige un banco de la lista", 400);
  const bank = known
    ? known.name
    : String(value("bank") ?? "")
        .trim()
        .slice(0, 80);
  if (!bank) throw new CustomError("Escribe el nombre del banco o cooperativa", 400);

  const type = String(value("type") ?? "").trim();
  const matchedType = BANK_ACCOUNT_TYPES.find((t) => t.toLowerCase() === type.toLowerCase());
  if (!matchedType) throw new CustomError("El tipo de cuenta debe ser Ahorros o Corriente", 400);

  const rawNumber = String(value("number") ?? "").replace(/[\s-]/g, "");
  if (!/^\d{5,20}$/.test(rawNumber)) {
    throw new CustomError("El número de cuenta debe tener solo dígitos (entre 5 y 20)", 400);
  }

  const holder = String(value("holder") ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  if (holder.length < 3) throw new CustomError("Escribe el nombre del titular de la cuenta", 400);

  const idNumber = digits(value("idNumber"));
  if (idNumber.length !== 10 && idNumber.length !== 13) {
    throw new CustomError("La cédula debe tener 10 dígitos o el RUC 13", 400);
  }

  const logoUrl = String(value("logoUrl") ?? "").trim();
  if (logoUrl && !/^https:\/\/\S+$/.test(logoUrl)) {
    throw new CustomError("El logo debe ser un enlace https", 400);
  }

  const active = value("active");
  return {
    bank,
    bankCode: known ? known.code : OTHER_BANK,
    type: matchedType,
    number: rawNumber,
    holder,
    idNumber,
    active: active === undefined ? true : active === true || active === "true",
    logoUrl: logoUrl.slice(0, 500),
  };
}

function findAccount(settings: ISettings, id: unknown) {
  const key = String(id ?? "");
  if (!isValidObjectId(key)) throw new CustomError("Cuenta no encontrada", 404);
  const index = (settings.bankAccounts || []).findIndex((a) => String(a._id) === key);
  if (index < 0) throw new CustomError("Cuenta no encontrada", 404);
  return index;
}

/** Con transferencias encendidas no se puede quedar sin ninguna cuenta activa. */
function assertKeepsActive(settings: ISettings, next: IBankAccount[]) {
  if (!settings.acceptTransfers) return;
  if (!next.some((a) => a.active !== false && a.number)) throw new CustomError(LAST_ACTIVE, 400);
}

async function saveAccounts(accounts: IBankAccount[]) {
  await Setting.updateOne({ key: "main" }, { $set: { bankAccounts: accounts } });
  return getPayments();
}

export async function createAccount(body: any) {
  const settings = await getSettings();
  const accounts = settings.bankAccounts || [];
  if (accounts.length >= MAX_ACCOUNTS) {
    throw new CustomError(`Puedes tener hasta ${MAX_ACCOUNTS} cuentas`, 400);
  }
  const account = { _id: new Types.ObjectId(), ...parseAccount(body) };
  if (accounts.some((a) => a.number === account.number && a.bankCode === account.bankCode)) {
    throw new CustomError("Esa cuenta ya está registrada", 400);
  }
  return saveAccounts([...accounts, account]);
}

export async function updateAccount(id: unknown, body: any) {
  const settings = await getSettings();
  const index = findAccount(settings, id);
  const accounts = [...settings.bankAccounts];
  accounts[index] = { _id: accounts[index]._id, ...parseAccount(body, accounts[index]) };
  assertKeepsActive(settings, accounts);
  return saveAccounts(accounts);
}

export async function deleteAccount(id: unknown) {
  const settings = await getSettings();
  const index = findAccount(settings, id);
  const accounts = settings.bankAccounts.filter((_, i) => i !== index);
  assertKeepsActive(settings, accounts);
  return saveAccounts(accounts);
}

/**
 * Cuenta elegida para un pedido por transferencia: por id (web) o por nombre del
 * banco (bot). Con una sola cuenta activa es esa. Sin elección, null.
 */
export function resolveTransferAccount(settings: ISettings, choice: unknown): IBankAccount | null {
  const accounts = activeBankAccounts(settings);
  if (accounts.length === 1) return accounts[0];
  const key = String(choice ?? "").trim();
  if (!key) return null;
  return (
    accounts.find((a) => String(a._id) === key) ||
    accounts.find((a) => a.bank.toLowerCase() === key.toLowerCase()) ||
    null
  );
}

/** Cuentas que se le muestran al cliente de un pedido: la que eligió o todas las activas. */
export function accountsForOrder(settings: ISettings, chosenBank: string) {
  const accounts = activeBankAccounts(settings);
  const chosen = chosenBank ? accounts.filter((a) => a.bank === chosenBank) : [];
  return (chosen.length ? chosen : accounts).map(publicAccount);
}
