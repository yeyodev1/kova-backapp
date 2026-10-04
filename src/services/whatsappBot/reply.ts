import { casualMarks } from "./texts";
import type { BotState, TurnResult } from "./types";

/** Arma el resultado del turno. Todo texto pasa por el filtro de signos. */
export function reply(
  state: BotState,
  rawText: string,
  decision: string,
  extra: Partial<TurnResult> = {},
): TurnResult {
  const text = casualMarks(rawText);
  state.lastQuestion = text.slice(-300);
  return {
    state,
    reply: text,
    route: "conversation",
    intent: "conversar",
    step: state.stage,
    decision,
    ...extra,
  };
}
