import mongoose, { Schema } from "mongoose";

export interface ICounter {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<ICounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);

export const Counter =
  mongoose.models.Counter || mongoose.model<ICounter>("Counter", counterSchema);

/**
 * Siguiente valor de una secuencia. El $inc con upsert es atómico en Mongo:
 * dos pedidos simultáneos nunca reciben el mismo número.
 */
export async function nextSequence(name: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return doc.seq;
}

/** KV-1001, KV-1002... */
export async function nextOrderNumber(): Promise<string> {
  const seq = await nextSequence("order");
  return `KV-${1000 + seq}`;
}
