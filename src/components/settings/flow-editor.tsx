"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowDownIcon, ArrowUpIcon, ArrowUpRightIcon, ChevronDownIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/org-provider";
import { BotAvatar, StatusRing, UnassignedAvatar, UserAvatar } from "@/components/bits";
import { Picker, type Option } from "@/components/pickers";
import { botPickerEntries } from "@/lib/bot-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { STAGE_LABELS, stageStatus } from "@/lib/stages";
import { orgPath } from "@/lib/paths";
import { STATUS_STAGES, type Member, type Status, type StatusCategory } from "@/lib/types";
import {
  FLOW_INSTRUCTIONS_MAX,
  FLOW_MAX_STEPS,
  FLOW_NAME_MAX,
  FLOW_REMIND_MAX_DAYS,
  FLOW_STATUS_NAME_MAX,
  FLOW_WAIT_LABEL_MAX,
  validateFlow,
  type FlowAdvance,
  type FlowDirectory,
  type FlowLevel,
  type FlowStep,
  type FlowStepOwner,
  type ResolvedFlow,
} from "@/lib/flow-model";

/**
 * The flow editor (VEC-177, design docs/flows.md section 7). One component for the org default (steps name a
 * stage + preferred status name) and a project's own flow (steps name one of the project's statuses). Edits
 * stay local until Save; the same validateFlow the server runs checks the draft as you type, so errors show on
 * the step they belong to. A save by another admin (org.changed -> refreshed props, new `version`) replaces an
 * untouched draft and shows a notice over a dirty one.
 */

const STEP_STAGES = STATUS_STAGES.filter((s) => s !== "cancelled");
const STAGE_RINGS = STEP_STAGES.map(stageStatus);

const ADVANCE_LABELS: Record<FlowAdvance, string> = {
  complete: "When the owner completes it",
  wait: "Waits for an outside event",
  manual: "Only when moved by hand",
};
const ADVANCE_SHORT: Record<FlowAdvance, string> = { complete: "Moves on when completed", wait: "Waits for an event", manual: "Moved by hand" };

type Row = FlowStep & { rid: number; touched?: boolean };
let ridSeq = 0;
const toRows = (steps: readonly FlowStep[]): Row[] => steps.map((s) => ({ ...structuredClone(s), rid: ++ridSeq }));
const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

/** What gets sent: the stored step shape, without editor-only fields. */
function toPayload(rows: readonly Row[]): FlowStep[] {
  return rows.map((s) => ({
    id: s.id,
    name: s.name.trim(),
    status: s.status,
    owner: s.owner,
    instructions: s.instructions?.trim() ? s.instructions : undefined,
    advance: s.advance,
    wait: s.advance === "wait" ? (s.wait ?? { label: "" }) : undefined,
    required: s.required !== false,
    next: s.next ?? null,
  }));
}
const comparable = (steps: readonly FlowStep[]) =>
  JSON.stringify(
    steps.map((s) => ({
      id: s.id,
      name: s.name.trim(),
      status: { id: s.status.statusId ?? null, stage: s.status.stage, name: s.status.statusId ? null : (s.status.name ?? "").trim() },
      owner: { kind: s.owner.kind, id: s.owner.id ?? null },
      instructions: (s.instructions ?? "").trim(),
      advance: s.advance,
      wait: s.advance === "wait" ? { label: s.wait?.label ?? "", resolvers: s.wait?.resolvers ?? [], days: s.wait?.remindAfterDays ?? null } : null,
      required: s.required !== false,
      next: s.next ?? null,
    })),
  );

/* ---------------- owners ---------------- */

const ownerValue = (o: FlowStepOwner) => (o.kind === "bot" || o.kind === "person" ? `${o.kind}:${o.id ?? ""}` : o.kind);
function ownerFromValue(v: string): FlowStepOwner {
  if (v.startsWith("bot:")) return { kind: "bot", id: v.slice(4) };
  if (v.startsWith("person:")) return { kind: "person", id: v.slice(7) };
  return { kind: v as FlowStepOwner["kind"] };
}

/** "Keeps the assignee", "Any triage bot", a person's or bot's name. */
export function ownerLabel(o: FlowStepOwner, memberById: Map<string, Member>): string {
  if (o.kind === "keep") return "Keeps the assignee";
  if (o.kind === "triage") return "Any triage bot";
  if (o.kind === "none") return o.removed ? `Nobody (${o.removed.name} was removed)` : "Unassigned";
  return (o.id && memberById.get(o.id)?.name) || (o.kind === "bot" ? "Removed bot" : "Former member");
}

/** Settings page of a bot or person who owns a step (VEC-187 cross-link), or null for the other owner kinds and removed owners. */
export function ownerHref(slug: string, o: FlowStepOwner, memberById: Map<string, Member>): string | null {
  if ((o.kind !== "bot" && o.kind !== "person") || !o.id || !memberById.has(o.id)) return null;
  return orgPath(slug, "settings", o.kind === "bot" ? "bots" : "members", o.id);
}

export function OwnerIcon({ owner, memberById, size = 16 }: { owner: FlowStepOwner; memberById: Map<string, Member>; size?: number }) {
  const m = owner.id ? memberById.get(owner.id) : undefined;
  if (owner.kind === "bot" && m) return <BotAvatar avatar={m.avatar} name={m.name} size={size} disabled={m.disabled} />;
  if (owner.kind === "person" && m) return <UserAvatar id={m.id} name={m.name} image={m.image} size={size} />;
  if (owner.kind === "triage")
    return (
      <span className="grid shrink-0 place-items-center rounded-full bg-chip text-[9px] font-semibold text-muted-foreground" style={{ width: size, height: size }} aria-hidden>
        T
      </span>
    );
  if (owner.kind === "keep")
    return (
      <span className="grid shrink-0 place-items-center rounded-full border border-dashed border-faint text-faint" style={{ width: size, height: size }} aria-hidden />
    );
  return <UnassignedAvatar size={size} />;
}

function useOwnerOptions(stage: StatusCategory): Option<string>[] {
  const { members, me } = useOrg();
  const people = members.filter((m) => m.kind === "user").sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name)));
  // Disabled bots (VEC-345) come last, grayed and unselectable; a step that already names one still shows it.
  const bots = botPickerEntries(members.filter((m) => m.kind === "bot"), (a, b) => a.name.localeCompare(b.name));
  const icon = (o: FlowStepOwner) => <OwnerIcon owner={o} memberById={new Map(members.map((m) => [m.id, m]))} size={18} />;
  return [
    { value: "keep", label: "Keep the assignee", hint: "whoever has it", icon: icon({ kind: "keep" }) },
    ...(stage === "triage" ? [{ value: "triage", label: "Any triage bot", hint: "triage queue", icon: icon({ kind: "triage" }) }] : []),
    { value: "none", label: "Unassigned", hint: "pool", icon: icon({ kind: "none" }) },
    ...people.map((m) => ({
      value: `person:${m.id}`,
      label: m.id === me.id ? `${m.name} (you)` : m.name,
      hint: m.email,
      group: "People",
      icon: <UserAvatar id={m.id} name={m.name} image={m.image} size={18} />,
    })),
    ...bots.map(({ bot: m, disabled }) => ({
      value: `bot:${m.id}`,
      label: m.name,
      hint: disabled ? "bot disabled" : "bot",
      group: "Bots",
      disabled,
      icon: <BotAvatar avatar={m.avatar} name={m.name} size={18} />,
    })),
  ];
}

/* ---------------- editor ---------------- */

const control =
  "inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-[13px] shadow-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30";

export function FlowEditor({
  level,
  steps: saved,
  version,
  statuses,
  counts,
  skippedIn,
  canEdit,
  onSave,
  footer,
  label,
}: {
  level: FlowLevel;
  steps: FlowStep[];
  /** Saved version; a change from elsewhere replaces an untouched draft. */
  version: number;
  /** Project level: the project's statuses in order. */
  statuses?: Status[];
  /** Open tasks at each step id. */
  counts?: Record<string, number>;
  /** Org level: step id -> keys of inheriting projects that skip it. */
  skippedIn?: Record<string, string[]>;
  canEdit: boolean;
  onSave: (steps: FlowStep[]) => Promise<{ ok: boolean; error?: string }>;
  /** Extra controls on the left of the save bar (e.g. Reset to default). */
  footer?: React.ReactNode;
  label: string;
}) {
  const { members } = useOrg();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const dir: FlowDirectory = useMemo(
    () => ({
      bots: new Map(members.filter((m) => m.kind === "bot").map((m) => [m.id, m.name])),
      people: new Map(members.filter((m) => m.kind === "user").map((m) => [m.id, m.name])),
    }),
    [members],
  );
  const [draft, setDraft] = useState(() => ({ version, saved, rows: toRows(saved) }));
  const [stale, setStale] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [removing, setRemoving] = useState<number | null>(null);
  const [pending, start] = useTransition();

  const rows = draft.rows;
  const dirty = comparable(toPayload(rows)) !== comparable(draft.saved);
  // A newer saved flow arrived (another admin, or this tab's own save): adopt it unless there are unsaved edits.
  // Matching content keeps the rows (and which cards are open); an untouched draft takes the new steps.
  if (version !== draft.version || saved !== draft.saved) {
    const same = comparable(toPayload(rows)) === comparable(saved);
    if (same || !dirty) {
      setDraft({ version, saved, rows: same ? rows : toRows(saved) });
      if (stale) setStale(false);
    } else if (version !== draft.version && !stale) {
      setStale(true);
    }
  }

  const check = useMemo(
    () => validateFlow(toPayload(rows), { level, statuses: statuses?.map((s) => ({ id: s.id, name: s.name, category: s.category, order: s.order })), dir, newId }),
    [rows, level, statuses, dir],
  );
  const stepErrors = check.ok ? {} : check.stepErrors;
  const flowErrors = check.ok ? [] : check.flowErrors;

  const setRows = (fn: (rs: Row[]) => Row[]) => {
    setServerError(null);
    setDraft((d) => ({ ...d, rows: fn(d.rows) }));
  };
  const update = (rid: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, ...patch, touched: true } : r)));
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const j = i + d;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const remove = (rid: number) => {
    setRemoving(null);
    setRows((rs) => rs.filter((r) => r.rid !== rid).map((r) => (r.next && !rs.some((x) => x.rid !== rid && x.id === r.next) ? { ...r, next: null } : r)));
  };
  const add = () => {
    const firstStarted = statuses?.find((s) => s.category === "started") ?? statuses?.find((s) => s.category === "unstarted");
    const rid = (ridSeq = Math.max(ridSeq, ...rows.map((x) => x.rid)) + 1);
    const step: Row = {
      rid,
      id: newId(),
      name: "",
      status:
        level === "project" && firstStarted
          ? { statusId: firstStarted.id, stage: firstStarted.category, name: firstStarted.name }
          : { stage: "started" },
      owner: { kind: "keep" },
      advance: "complete",
      required: true,
      next: null,
    };
    setRows((rs) => {
      const at = rs.length && rs[rs.length - 1].status.stage === "done" ? rs.length - 1 : rs.length;
      return [...rs.slice(0, at), step, ...rs.slice(at)];
    });
    setOpen((o) => new Set(o).add(step.rid));
  };
  const discard = () => {
    setDraft({ version, saved, rows: toRows(saved) });
    setStale(false);
    setShowAll(false);
    setServerError(null);
  };
  const save = () => {
    if (!check.ok) {
      setShowAll(true);
      // Open the steps with errors so nothing is hidden behind a collapsed card.
      setOpen((o) => new Set([...o, ...rows.filter((_, i) => stepErrors[i]?.length).map((r) => r.rid)]));
      return;
    }
    start(async () => {
      const r = await onSave(toPayload(rows));
      if (!r.ok) {
        setServerError(r.error ?? "Couldn't save the flow.");
        return;
      }
      setServerError(null);
      setShowAll(false);
      setStale(false);
      toast.success("Flow saved");
    });
  };

  const stepNames = rows.map((r, i) => r.name.trim() || `Step ${i + 1}`);

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-3" aria-label={label} role="group">
      {stale && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-sidebar px-3.5 py-2.5 text-[13px] text-muted-foreground">
          <span className="min-w-0 flex-1">Someone else saved this flow while you were editing. Saving now replaces their version.</span>
          <Button size="sm" variant="outline" onClick={discard}>
            Load their version
          </Button>
        </div>
      )}
      <ol className="grid grid-cols-1 gap-2" aria-label={`${label} steps`}>
        {rows.map((r, i) => (
          <StepCard
            key={r.rid}
            row={r}
            index={i}
            count={rows.length}
            level={level}
            statuses={statuses}
            canEdit={canEdit}
            open={open.has(r.rid)}
            onToggle={() =>
              setOpen((o) => {
                const n = new Set(o);
                if (n.has(r.rid)) n.delete(r.rid);
                else n.add(r.rid);
                return n;
              })
            }
            errors={showAll || r.touched ? (stepErrors[i] ?? []) : []}
            tasks={counts?.[r.id] ?? 0}
            skippedIn={skippedIn?.[r.id] ?? []}
            memberById={memberById}
            others={rows.filter((x) => x.rid !== r.rid).map((x) => ({ id: x.id, name: stepNames[rows.indexOf(x)] }))}
            onChange={(patch) => update(r.rid, patch)}
            onMove={(d) => move(i, d)}
            removing={removing === r.rid}
            onRemove={() => ((counts?.[r.id] ?? 0) > 0 ? setRemoving(r.rid) : remove(r.rid))}
            onConfirmRemove={() => remove(r.rid)}
            onCancelRemove={() => setRemoving(null)}
          />
        ))}
      </ol>
      {(showAll || rows.some((r) => r.touched)) && flowErrors.length > 0 && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {flowErrors.join(" ")}
        </p>
      )}
      {serverError && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
          {serverError}
        </p>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={add} disabled={rows.length >= FLOW_MAX_STEPS}>
            <PlusIcon className="size-3.5" /> Add step
          </Button>
          {footer}
          <span className="flex-1" />
          {dirty && (
            <Button variant="ghost" size="sm" onClick={discard} disabled={pending}>
              Discard
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={pending || !dirty}>
            {pending ? "Saving…" : "Save flow"}
          </Button>
        </div>
      )}
    </div>
  );
}

function StepCard({
  row: r,
  index: i,
  count,
  level,
  statuses,
  canEdit,
  open,
  onToggle,
  errors,
  tasks,
  skippedIn,
  memberById,
  others,
  onChange,
  onMove,
  removing,
  onRemove,
  onConfirmRemove,
  onCancelRemove,
}: {
  row: Row;
  index: number;
  count: number;
  level: FlowLevel;
  statuses?: Status[];
  canEdit: boolean;
  open: boolean;
  onToggle: () => void;
  errors: string[];
  tasks: number;
  skippedIn: string[];
  memberById: Map<string, Member>;
  others: { id: string; name: string }[];
  onChange: (patch: Partial<Row>) => void;
  onMove: (d: -1 | 1) => void;
  removing: boolean;
  onRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
}) {
  const { org } = useOrg();
  const stage = r.status.stage;
  const ownerOptions = useOwnerOptions(stage);
  const ownerPage = ownerHref(org.slug, r.owner, memberById);
  const isDone = stage === "done";
  const name = r.name.trim() || `Step ${i + 1}`;
  const projectStatus = level === "project" ? statuses?.find((s) => s.id === r.status.statusId) : undefined;
  const ringList = level === "project" && statuses ? statuses : STAGE_RINGS;
  const ring = projectStatus ?? stageStatus(stage);
  const warnings: string[] = [];
  if (r.status.deleted || (level === "project" && r.status.statusId == null && r.status.name)) {
    warnings.push(`Its status${r.status.name ? ` ${r.status.name}` : ""} was deleted. Pick another one.`);
  }
  if (r.owner.kind === "none" && r.owner.removed) warnings.push(`${r.owner.removed.name} was removed from the organisation, so nobody owns this step.`);
  if (skippedIn.length) warnings.push(`Skipped in ${skippedIn.join(", ")}: no ${STAGE_LABELS[stage]} status there.`);
  const errId = `step-${r.rid}-errors`;

  const summary = [
    level === "org" && r.status.name?.trim() ? `Prefers “${r.status.name.trim()}”` : null,
    isDone ? "Ends the flow" : ADVANCE_SHORT[r.advance],
    !isDone && r.advance === "wait" && r.wait?.label ? `“${r.wait.label}”` : null,
    !isDone && r.required === false ? "Optional" : null,
    r.next ? `then ${others.find((o) => o.id === r.next)?.name ?? "?"}` : null,
    r.instructions?.trim() ? "Has instructions" : "No instructions",
    tasks ? `${tasks} task${tasks === 1 ? "" : "s"} here` : null,
  ].filter(Boolean);

  return (
    <li
      className={cn("min-w-0 rounded-[10px] border bg-background", errors.length ? "border-destructive/50" : "border-border")}
      aria-label={`Step ${i + 1}: ${name}`}
      aria-describedby={errors.length ? errId : undefined}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <span className="tabular grid size-6 shrink-0 place-items-center rounded-full bg-chip text-[12px] font-medium text-muted-foreground" aria-hidden>
          {i + 1}
        </span>
        <Input
          value={r.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Step name"
          aria-label="Step name"
          aria-invalid={(errors.length > 0 && !r.name.trim()) || undefined}
          maxLength={FLOW_NAME_MAX}
          disabled={!canEdit}
          className="h-8 min-w-0 flex-1 basis-40 border-transparent bg-transparent font-medium shadow-none hover:border-input focus-visible:border-input sm:max-w-48 dark:bg-transparent"
        />
        <div className="order-last flex w-full min-w-0 flex-wrap items-center gap-2 sm:order-none sm:w-auto">
          {level === "project" ? (
            <Select
              value={projectStatus?.id ?? ""}
              disabled={!canEdit}
              onValueChange={(id) => {
                const s = statuses?.find((x) => x.id === id);
                if (s) onChange({ status: { statusId: s.id, stage: s.category, name: s.name }, ...(s.category !== "triage" && r.owner.kind === "triage" ? { owner: { kind: "keep" } } : {}) });
              }}
            >
              <SelectTrigger size="sm" className="w-40 min-w-0" aria-label={`Status for ${name}`}>
                <SelectValue placeholder="Pick a status" />
              </SelectTrigger>
              <SelectContent>
                {(statuses ?? [])
                  .filter((s) => s.category !== "cancelled")
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <StatusRing status={s} statuses={statuses ?? []} size={14} />
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          ) : (
            <Select
              value={stage}
              disabled={!canEdit}
              onValueChange={(v) => {
                const st = v as StatusCategory;
                onChange({ status: { ...r.status, stage: st }, ...(st !== "triage" && r.owner.kind === "triage" ? { owner: { kind: "keep" } } : {}) });
              }}
            >
              <SelectTrigger size="sm" className="w-36 min-w-0" aria-label={`Stage for ${name}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STEP_STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    <StatusRing status={stageStatus(s)} statuses={STAGE_RINGS} size={14} />
                    {STAGE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Picker label={`Owner of ${name}`} value={ownerValue(r.owner)} options={ownerOptions} onChange={(v) => onChange({ owner: ownerFromValue(v) })} placeholder="Owner…" disabled={!canEdit}>
            {/* Room for the owner link comes out of the picker, so the row keeps its width and doesn't wrap. */}
            <button type="button" className={cn(control, ownerPage ? "w-36 sm:w-40" : "w-44 sm:w-48")}>
              <OwnerIcon owner={r.owner} memberById={memberById} />
              <span className="truncate">{ownerLabel(r.owner, memberById)}</span>
            </button>
          </Picker>
          {ownerPage && (
            <Button asChild variant="ghost" size="icon-sm" className="text-faint hover:text-foreground">
              <Link href={ownerPage} aria-label={`Open ${ownerLabel(r.owner, memberById)}`} title={`Open ${ownerLabel(r.owner, memberById)}`}>
                <ArrowUpRightIcon />
              </Link>
            </Button>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" aria-label={open ? `Hide details of ${name}` : `Show details of ${name}`} aria-expanded={open} onClick={onToggle}>
            <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
          </Button>
          {canEdit && (
            <>
              <Button variant="ghost" size="icon-sm" aria-label={`Move step ${name} up`} disabled={i === 0} onClick={() => onMove(-1)}>
                <ArrowUpIcon />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Move step ${name} down`} disabled={i === count - 1} onClick={() => onMove(1)}>
                <ArrowDownIcon />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove step ${name}`} className="text-faint hover:text-destructive" disabled={count <= 1} onClick={onRemove}>
                <XIcon />
              </Button>
            </>
          )}
        </div>
      </div>

      {!open && <p className="truncate px-3 pb-2.5 pl-11 text-[12.5px] text-faint">{summary.join(" · ")}</p>}

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="grid gap-1 px-3 pb-2.5 pl-11">
          {errors.length > 0 && (
            <ul id={errId} role="alert" className="grid gap-0.5 text-[12.5px] text-destructive">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {warnings.map((w) => (
            <p key={w} className="flex items-start gap-1.5 text-[12.5px] text-muted-foreground">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden /> {w}
            </p>
          ))}
        </div>
      )}

      {removing && (
        <div className="mx-3 mb-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-sidebar px-3 py-2 text-[13px]">
          <span className="min-w-0 flex-1">
            {tasks} open task{tasks === 1 ? " is" : "s are"} at this step. After saving, {tasks === 1 ? "it moves" : "they move"} to the step that matches {tasks === 1 ? "its" : "their"} status.
          </span>
          <Button size="sm" variant="destructive" onClick={onConfirmRemove}>
            Remove step
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancelRemove}>
            Cancel
          </Button>
        </div>
      )}

      {open && (
        <div className="grid gap-4 border-t border-border px-3 py-3 sm:pl-11">
          {level === "org" && (
            <div className="grid gap-1.5">
              <Label htmlFor={`step-${r.rid}-status`} className="text-[12.5px]">
                Preferred status name
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <StatusRing status={ring} statuses={ringList} size={14} />
                <Input
                  id={`step-${r.rid}-status`}
                  value={r.status.name ?? ""}
                  onChange={(e) => onChange({ status: { ...r.status, name: e.target.value } })}
                  placeholder={STAGE_LABELS[stage]}
                  maxLength={FLOW_STATUS_NAME_MAX}
                  disabled={!canEdit}
                  className="h-8 w-56 max-w-full text-[13px] md:text-[13px]"
                />
              </div>
              <p className="text-[12px] text-faint">Each project uses its {STAGE_LABELS[stage]} status with this name, else its first {STAGE_LABELS[stage]} status.</p>
            </div>
          )}

          {!isDone && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label className="text-[12.5px]">Moves on</Label>
                <Select
                  value={r.advance}
                  disabled={!canEdit}
                  onValueChange={(v) => onChange({ advance: v as FlowAdvance, ...(v === "wait" && !r.wait ? { wait: { label: "", resolvers: [], remindAfterDays: null } } : {}) })}
                >
                  <SelectTrigger size="sm" className="w-full" aria-label={`How ${name} moves on`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(ADVANCE_LABELS) as FlowAdvance[]).map((a) => (
                      <SelectItem key={a} value={a}>
                        {ADVANCE_LABELS[a]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-[12.5px]">Then</Label>
                <Select value={r.next ?? "__next"} disabled={!canEdit} onValueChange={(v) => onChange({ next: v === "__next" ? null : v })}>
                  <SelectTrigger size="sm" className="w-full" aria-label={`Step after ${name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__next">The next step in order</SelectItem>
                    {others.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        Jump to {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {!isDone && r.advance === "wait" && <WaitFields row={r} name={name} canEdit={canEdit} memberById={memberById} onChange={onChange} />}

          {!isDone && (
            <label className="flex items-start gap-2.5 text-[13px]">
              <Switch checked={r.required !== false} onCheckedChange={(v) => onChange({ required: v })} disabled={!canEdit} aria-label={`${name} is required`} className="mt-0.5" />
              <span>
                Required
                <span className="block text-[12px] text-faint">A bot can&rsquo;t finish the task while this step is still ahead. People always can.</span>
              </span>
            </label>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor={`step-${r.rid}-instructions`} className="text-[12.5px]">
              Instructions
            </Label>
            <Textarea
              id={`step-${r.rid}-instructions`}
              value={r.instructions ?? ""}
              onChange={(e) => onChange({ instructions: e.target.value })}
              placeholder={isDone ? "Optional notes for whoever closes the task." : "What the owner should do at this step. Markdown works; bots get this with the hand-off."}
              maxLength={FLOW_INSTRUCTIONS_MAX}
              rows={3}
              disabled={!canEdit}
              className="min-h-20 text-[13px] md:text-[13px]"
            />
          </div>
        </div>
      )}
    </li>
  );
}

function WaitFields({
  row: r,
  name,
  canEdit,
  memberById,
  onChange,
}: {
  row: Row;
  name: string;
  canEdit: boolean;
  memberById: Map<string, Member>;
  onChange: (patch: Partial<Row>) => void;
}) {
  const { members, org } = useOrg();
  const wait = r.wait ?? { label: "", resolvers: [], remindAfterDays: null };
  const resolvers = wait.resolvers ?? [];
  const set = (patch: Partial<typeof wait>) => onChange({ wait: { ...wait, ...patch } });
  const botOptions: Option<string>[] = botPickerEntries(members.filter((m) => m.kind === "bot" && !resolvers.includes(m.id))).map(({ bot: m, disabled }) => ({
    value: m.id,
    label: m.name,
    disabled,
    icon: <BotAvatar avatar={m.avatar} name={m.name} size={18} />,
  }));
  return (
    <div className="grid gap-4 rounded-lg bg-sidebar px-3 py-3 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <Label htmlFor={`step-${r.rid}-wait`} className="text-[12.5px]">
          Waiting for
        </Label>
        <Input
          id={`step-${r.rid}-wait`}
          value={wait.label}
          onChange={(e) => set({ label: e.target.value })}
          placeholder="Reply received"
          maxLength={FLOW_WAIT_LABEL_MAX}
          disabled={!canEdit}
          className="h-8 text-[13px] md:text-[13px]"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`step-${r.rid}-remind`} className="text-[12.5px]">
          Remind after (days)
        </Label>
        <Input
          id={`step-${r.rid}-remind`}
          type="number"
          inputMode="numeric"
          min={1}
          max={FLOW_REMIND_MAX_DAYS}
          value={wait.remindAfterDays ?? ""}
          onChange={(e) => set({ remindAfterDays: e.target.value === "" ? null : Number(e.target.value) })}
          placeholder="No reminder"
          disabled={!canEdit}
          className="h-8 w-36 text-[13px] md:text-[13px]"
        />
      </div>
      <div className="grid gap-1.5 sm:col-span-2">
        <span className="text-[12.5px] font-medium">Bots that can mark it received</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {resolvers.map((id) => {
            const m = memberById.get(id);
            return (
              <span key={id} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-background pr-1 pl-2 text-[12.5px] ring-1 ring-border">
                {m && <BotAvatar avatar={m.avatar} name={m.name} size={14} disabled={m.disabled} />}
                {m ? (
                  <Link href={orgPath(org.slug, "settings", "bots", id)} className="hover:underline hover:underline-offset-2">
                    {m.name}
                  </Link>
                ) : (
                  "Removed bot"
                )}
                {canEdit && (
                  <button type="button" aria-label={`Remove ${m?.name ?? "bot"} from ${name}'s resolvers`} className="grid size-5 place-items-center rounded text-faint hover:text-foreground" onClick={() => set({ resolvers: resolvers.filter((x) => x !== id) })}>
                    <XIcon className="size-3" />
                  </button>
                )}
              </span>
            );
          })}
          {canEdit && botOptions.length > 0 && (
            <Picker label={`Add a bot that can resolve ${name}`} value={null} options={botOptions} onChange={(v) => set({ resolvers: [...resolvers, v] })} placeholder="Add bot…">
              <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
                <PlusIcon className="size-3.5" /> Add bot
              </button>
            </Picker>
          )}
          {!resolvers.length && <span className="text-[12px] text-faint">{canEdit ? "Besides the step owner, none." : "Only the step owner."}</span>}
        </div>
      </div>
    </div>
  );
}

/* ---------------- read-only resolved view ---------------- */

/** The flow a project runs, read-only (Using the org default). Adjusted steps carry their reason; skipped ones are listed. */
export function FlowPreview({ flow, statuses, label }: { flow: ResolvedFlow; statuses: Status[]; label: string }) {
  const { members, org } = useOrg();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-2">
      <ol className="min-w-0 divide-y divide-border rounded-[10px] border border-border" aria-label={label}>
        {flow.steps.map((s, i) => {
          const st = statuses.find((x) => x.id === s.status.id);
          return (
            <li key={s.id} className="px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="tabular grid size-6 shrink-0 place-items-center rounded-full bg-chip text-[12px] font-medium text-muted-foreground" aria-hidden>
                  {i + 1}
                </span>
                <span className="min-w-0 basis-28 truncate text-[13.5px] font-medium">{s.name}</span>
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
                  {st && <StatusRing status={st} statuses={statuses} size={14} />}
                  <span className="truncate">{s.status.name}</span>
                </span>
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
                  <OwnerIcon owner={s.owner} memberById={memberById} />
                  {(() => {
                    const href = ownerHref(org.slug, s.owner, memberById);
                    return href ? (
                      <Link href={href} className="truncate hover:text-foreground hover:underline hover:underline-offset-2">
                        {ownerLabel(s.owner, memberById)}
                      </Link>
                    ) : (
                      <span className="truncate">{ownerLabel(s.owner, memberById)}</span>
                    );
                  })()}
                </span>
                <span className="ml-auto text-[12px] text-faint">
                  {s.status.category === "done" ? "Ends the flow" : ADVANCE_SHORT[s.advance]}
                  {s.status.category !== "done" && !s.required ? " · Optional" : ""}
                </span>
              </div>
              {s.issues.map((iss) => (
                <p key={iss.code + iss.message} className="mt-1 flex items-start gap-1.5 pl-9 text-[12.5px] text-muted-foreground">
                  <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden /> {iss.message}
                </p>
              ))}
            </li>
          );
        })}
      </ol>
      {flow.skipped.length > 0 && (
        <p className="flex items-start gap-1.5 text-[12.5px] text-muted-foreground">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
          <span>
            Skipped here: {flow.skipped.map((s) => `${s.name} (${s.issues.map((x) => x.message.charAt(0).toLowerCase() + x.message.slice(1)).join("; ")})`).join(", ")}.
          </span>
        </p>
      )}
    </div>
  );
}
