import { Tracer, type LunaUnload } from "@luna/core";

export const { trace, errSignal } = Tracer("[SpotifyCsvImporter]");
export const unloads = new Set<LunaUnload>();
