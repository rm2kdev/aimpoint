// Converts flow steps between the client-safe model (hex ids, lib/flow-model.ts) and Mongo docs (ObjectIds).
// No "server-only" / path aliases, so migrations and one-off scripts can use it too.
import { ObjectId } from "mongodb";
import type { FlowStep } from "./flow-model";
import type { FlowStepDoc } from "./types";

const oid = (v: string | null | undefined) => (v && ObjectId.isValid(v) ? new ObjectId(v) : null);
const hex = (v: ObjectId | string | null | undefined) => (v == null ? null : typeof v === "string" ? v : v.toHexString());

export function flowStepsToDoc(steps: readonly FlowStep[]): FlowStepDoc[] {
  return steps.map((s) => {
    const doc: FlowStepDoc = {
      id: s.id,
      name: s.name,
      status: {
        stage: s.status.stage,
        ...(s.status.statusId ? { statusId: oid(s.status.statusId) } : {}),
        ...(s.status.name ? { name: s.status.name } : {}),
        ...(s.status.deleted ? { deleted: true } : {}),
      },
      owner: {
        kind: s.owner.kind,
        ...(s.owner.id ? { id: oid(s.owner.id) } : {}),
        ...(s.owner.removed ? { removed: s.owner.removed } : {}),
      },
      advance: s.advance,
      required: s.required !== false,
      next: s.next ?? null,
    };
    if (s.instructions) doc.instructions = s.instructions;
    if (s.wait) {
      doc.wait = {
        label: s.wait.label,
        resolvers: (s.wait.resolvers ?? []).map(oid).filter((x): x is ObjectId => !!x),
        remindAfterDays: s.wait.remindAfterDays ?? null,
      };
    }
    return doc;
  });
}

export function flowStepsFromDoc(steps: readonly FlowStepDoc[] | null | undefined): FlowStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => {
    const step: FlowStep = {
      id: s.id,
      name: s.name,
      status: {
        stage: s.status?.stage,
        ...(s.status?.statusId ? { statusId: hex(s.status.statusId) } : {}),
        ...(s.status?.name ? { name: s.status.name } : {}),
        ...(s.status?.deleted ? { deleted: true } : {}),
      },
      owner: {
        kind: s.owner?.kind ?? "none",
        ...(s.owner?.id ? { id: hex(s.owner.id) } : {}),
        ...(s.owner?.removed ? { removed: s.owner.removed } : {}),
      },
      advance: s.advance,
      required: s.required !== false,
      next: s.next ?? null,
    };
    if (s.instructions) step.instructions = s.instructions;
    if (s.wait) {
      step.wait = {
        label: s.wait.label,
        resolvers: (s.wait.resolvers ?? []).map((r: ObjectId) => hex(r)!).filter(Boolean),
        remindAfterDays: s.wait.remindAfterDays ?? null,
      };
    }
    return step;
  });
}
