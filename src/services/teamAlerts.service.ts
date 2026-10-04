import { env } from "../config/env";
import { User } from "../models/user.model";
import { layout, sendEmail } from "./email.service";

interface HumanRequest {
  phone: string;
  name: string;
  message: string;
  reply: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 09XXXXXXXX → 5939XXXXXXXX para abrir el chat con wa.me. */
function waNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("0") ? `593${digits.slice(1)}` : digits;
}

/**
 * Avisa por correo a los administradores que tienen activado el aviso (por defecto, todos)
 * cuando un cliente del bot pide una persona. Nunca lanza: un correo que falla no debe
 * cortar la respuesta del bot.
 */
export async function notifyHumanRequest(request: HumanRequest): Promise<void> {
  try {
    const admins = await User.find({
      accountType: "admin",
      isActive: true,
      notifyHumanRequests: { $ne: false },
    })
      .select("email")
      .lean();
    if (!admins.length) return;

    const who = request.name.trim() || "Un cliente";
    const chatUrl = `https://wa.me/${waNumber(request.phone)}`;
    const panelUrl = `${env.FRONTEND_URL.replace(/\/+$/, "")}/admin/bot`;
    const html = layout(
      "Un cliente pide un asesor",
      `<p><strong>${escapeHtml(who)}</strong> (${escapeHtml(request.phone)}) quiere hablar con una persona.
       El bot quedó en pausa 60 minutos para ese chat.</p>
       <p style="margin:16px 0 4px;color:#71717a;font-size:13px">Lo que escribió:</p>
       <blockquote style="margin:0;padding:12px 16px;background:#f4f4f5;border-radius:10px">${escapeHtml(request.message || "(sin texto)")}</blockquote>
       <p style="margin:24px 0">
         <a href="${chatUrl}" style="background:#1f9d55;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Responder por WhatsApp</a>
       </p>
       <p style="font-size:13px;color:#71717a">Ver la conversación en el panel: <a href="${panelUrl}">${panelUrl}</a></p>
       <p style="font-size:12px;color:#a1a1aa">Recibes este aviso porque lo tienes activado en Panel → Ajustes → Avisos de asesor.</p>`,
    );
    const subject = `Asesor solicitado: ${who} · ${request.phone}`;
    await Promise.all(admins.map((admin: any) => sendEmail(admin.email, subject, html)));
  } catch (error: any) {
    console.error("[alertas] no se pudo avisar del asesor:", error?.message);
  }
}
