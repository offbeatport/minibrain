import type { ModelRow, ModelVersionRow } from "~/api/client";

export type Entry = { key: string; model: ModelRow; version: ModelVersionRow | null };
