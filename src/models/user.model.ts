import bcrypt from "bcryptjs";
import mongoose, { Schema } from "mongoose";

export const ACCOUNT_TYPES = ["customer", "admin"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface IUser {
  email: string;
  password: string;
  name: string;
  phone: string;
  accountType: AccountType;
  /** Recibe correo cuando un cliente del bot pide un asesor. Por defecto sí. */
  notifyHumanRequests: boolean;
  /** Recibe correo de cada pedido (nuevo, pago, comprobante, cancelación). Por defecto sí. */
  notifyOrders: boolean;
  isActive: boolean;
  lastLoginAt: Date | null;
  resetPasswordToken: string | null;
  resetPasswordExpires: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    // select: false — nunca viaja en un find() por descuido.
    password: { type: String, required: true, select: false },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    accountType: { type: String, enum: ACCOUNT_TYPES, default: "customer" },
    notifyHumanRequests: { type: Boolean, default: true },
    notifyOrders: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    resetPasswordToken: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    next();
    return;
  }
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

export const User = mongoose.models.User || mongoose.model<IUser>("User", userSchema);
