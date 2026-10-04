/**
 * Bitácora del bot desde la terminal (la misma que ve el panel).
 *
 *   pnpm bot:logs                    últimos 60 pasos de todos los números
 *   pnpm bot:logs -- 0991234567      solo ese número
 *   pnpm bot:logs -- --errors        solo errores
 *   pnpm bot:logs -- --human         solo pedidos de asesor
 *   pnpm bot:logs -- --limit 200
 *
 * Ojo: usa DB_URI. Para desarrollo exporta la de kova-dev antes de correrlo.
 */
import mongoose from "mongoose";
import { env } from "../config/env";
import { dbConnect } from "../config/mongo";
import { BotEvent } from "../models/botEvent.model";
import { toSessionPhone } from "../services/whatsappBot/input";

async function main() {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) || 60 : 60;
  const phoneArg = args.find((arg) => /^\+?\d{7,}$/.test(arg) || arg.startsWith("lid:"));
  const filter: Record<string, unknown> = {};
  if (phoneArg) filter.phone = toSessionPhone(phoneArg);
  if (args.includes("--errors")) filter.kind = "error";
  if (args.includes("--human")) filter.kind = "human_request";

  console.log(`Base: ${env.DB_URI.split("/").pop()?.split("?")[0]}`);
  await dbConnect();
  const events: any[] = await BotEvent.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  for (const event of events.reverse()) {
    const time = new Date(event.createdAt).toLocaleString("es-EC", {
      timeZone: "America/Guayaquil",
    });
    const action =
      event.kind === "decision"
        ? "decide"
        : event.kind === "human_request"
          ? "🙋 asesor"
          : event.kind === "error"
            ? "❌"
            : "responde";
    console.log(
      `${time} ${event.phone} /${event.endpoint} ${action} → ${event.route || "-"} ${event.decision || ""} ${event.durationMs}ms`,
    );
    if (event.message) console.log(`   👤 ${event.message.replace(/\s+/g, " ").slice(0, 300)}`);
    if (event.reply) console.log(`   🤖 ${event.reply.replace(/\s+/g, " ").slice(0, 300)}`);
    if (event.error) console.log(`   ❌ ${event.error}`);
  }
  console.log(`\n${events.length} pasos${phoneArg ? ` de ${phoneArg}` : ""}`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
