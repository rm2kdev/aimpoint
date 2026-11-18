"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  FORM_EMAIL_HELP_MAX,
  FORM_FIELD_HELP_MAX,
  FORM_FIELD_LABEL_MAX,
  FORM_FIELDS_MAX,
  FORM_FIELD_KINDS,
  type FormField,
  type FormFieldKind,
} from "@/lib/form-fields-core";
import { cn } from "@/lib/utils";

/**
 * TPA-401: the custom fields, email note and hide-description part of the external form dialog
 * (settings/project-forms.tsx). Controlled: the dialog owns the state and saves it through updateProjectForm /
 * createProjectForm, whose UserError (lib/form-fields-core.ts cleanFormFields) it shows inline.
 */

export const FIELD_KIND_LABELS: Record<FormFieldKind, string> = {
  short: "Short text",
  long: "Long text",
  screenshot: "Screenshot",
};

const KIND_HINTS: Record<FormFieldKind, string> = {
  short: "One line, up to 300 characters.",
  long: "A paragraph, up to 5,000 characters.",
  screenshot: "Up to 5 images, 5 MB each.",
};

/** Field ids the server keeps (`[A-Za-z0-9_-]{1,32}`). Not crypto.randomUUID: it's missing on plain-http LAN origins. */
export const newFieldId = () =>
  "f" +
  Array.from({ length: 11 }, () => "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 36)]).join("");

export const blankField = (): FormField => ({ id: newFieldId(), label: "", help: null, kind: "short", required: false });

/** Whether two field lists save the same (labels/help compared trimmed, as the server stores them). */
export function sameFields(a: FormField[], b: FormField[]) {
  const norm = (l: FormField[]) =>
    JSON.stringify(l.map((f) => [f.id, f.label.replace(/\s+/g, " ").trim(), (f.help ?? "").trim(), f.kind, f.required]));
  return norm(a) === norm(b);
}

/** What a field list should be sent as: trimmed help, null when empty. Labels go as typed; the server trims them. */
export const fieldsInput = (fields: FormField[]) => fields.map((f) => ({ ...f, help: f.help?.trim() || null }));

export const hasTextField = (fields: FormField[]) => fields.some((f) => f.kind !== "screenshot");

export function FormFieldsEditor({
  fields,
  onFields,
  emailHelp,
  onEmailHelp,
  hideDescription,
  onHideDescription,
  invalidIds,
}: {
  fields: FormField[];
  onFields: (f: FormField[]) => void;
  emailHelp: string;
  onEmailHelp: (v: string) => void;
  hideDescription: boolean;
  onHideDescription: (v: boolean) => void;
  /** Fields to mark invalid (empty or repeated labels after a save attempt). */
  invalidIds: Set<string>;
}) {
  const patch = (id: string, p: Partial<FormField>) => onFields(fields.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    onFields(next);
  };
  const canHide = hasTextField(fields);

  return (
    <>
      <fieldset className="grid gap-2.5" aria-describedby="form-fields-desc">
        <legend className="mb-1.5 text-sm leading-none font-medium">Extra fields</legend>
        <p id="form-fields-desc" className="-mt-1 text-[12.5px] text-muted-foreground">
          Questions asked after the title and description, in this order. Each answer becomes its own section in the task.
        </p>
        {fields.length > 0 && (
          <ol className="grid gap-2" aria-label="Extra fields">
            {fields.map((f, i) => {
              const n = i + 1;
              const name = f.label.trim() || `Field ${n}`;
              const bad = invalidIds.has(f.id);
              return (
                <li key={f.id} data-field-id={f.id} className="grid gap-2 rounded-lg border border-border p-2.5">
                  <div className="flex items-start gap-2">
                    <div className="grid min-w-0 flex-1 gap-1">
                      <Label htmlFor={`field-label-${f.id}`} className="sr-only">
                        Field {n} label
                      </Label>
                      <Input
                        id={`field-label-${f.id}`}
                        value={f.label}
                        onChange={(e) => patch(f.id, { label: e.target.value })}
                        placeholder={i === 0 ? "Steps to reproduce" : "Label"}
                        maxLength={FORM_FIELD_LABEL_MAX}
                        aria-invalid={bad || undefined}
                        className="h-8"
                      />
                    </div>
                    <Select value={f.kind} onValueChange={(v) => patch(f.id, { kind: v as FormFieldKind })}>
                      <SelectTrigger size="sm" className="w-32 shrink-0" aria-label={`${name} kind`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FORM_FIELD_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {FIELD_KIND_LABELS[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex shrink-0 items-center">
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move ${name} down`}
                        disabled={i === fields.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${name}`}
                        className="text-faint hover:text-destructive"
                        onClick={() => onFields(fields.filter((x) => x.id !== f.id))}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                  <Input
                    value={f.help ?? ""}
                    onChange={(e) => patch(f.id, { help: e.target.value })}
                    placeholder="Help text (optional)"
                    maxLength={FORM_FIELD_HELP_MAX}
                    aria-label={`${name} help text`}
                    className="h-8 text-[13px] md:text-[13px]"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[12px] text-faint">{KIND_HINTS[f.kind]}</span>
                    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px]">
                      Required
                      <Switch checked={f.required} onCheckedChange={(v) => patch(f.id, { required: v })} aria-label={`${name} required`} />
                    </label>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={fields.length >= FORM_FIELDS_MAX}
            onClick={() => onFields([...fields, blankField()])}
          >
            <PlusIcon className="size-3.5" /> Add field
          </Button>
          <span className="text-[12px] text-faint">
            {fields.length >= FORM_FIELDS_MAX ? `That's the most a form can have (${FORM_FIELDS_MAX}).` : `${fields.length} of ${FORM_FIELDS_MAX}`}
          </span>
        </div>
      </fieldset>

      <div className="grid divide-y divide-border rounded-lg border border-border">
        <label className={cn("flex items-center justify-between gap-3 px-3 py-2.5", !canHide && "cursor-not-allowed")}>
          <span className="leading-tight">
            <span className={cn("block text-[13.5px] font-medium", !canHide && "text-muted-foreground")}>Hide the description box</span>
            <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
              {canHide ? "Submitters answer your fields instead of a free-form description." : "Needs a short or long text field."}
            </span>
          </span>
          <Switch
            checked={canHide && hideDescription}
            disabled={!canHide}
            onCheckedChange={onHideDescription}
            aria-label="Hide the description box"
          />
        </label>
        <div className="grid gap-1.5 px-3 py-2.5">
          <Label htmlFor="form-email-help" className="text-[13.5px]">
            Email note <span className="font-normal text-faint">(optional)</span>
          </Label>
          <Input
            id="form-email-help"
            value={emailHelp}
            onChange={(e) => onEmailHelp(e.target.value)}
            placeholder="We'll only use this to ask about your report."
            maxLength={FORM_EMAIL_HELP_MAX}
            className="h-8"
          />
          <span className="text-[12.5px] text-muted-foreground">Shown under the optional Email field, e.g. why you ask for it.</span>
        </div>
      </div>
    </>
  );
}

/** Ids of fields with an empty or repeated label (case-insensitive), the two mistakes worth marking before saving. */
export function invalidFieldIds(fields: FormField[]): Set<string> {
  const seen = new Map<string, string>();
  const bad = new Set<string>();
  for (const f of fields) {
    const key = f.label.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key) bad.add(f.id);
    else if (seen.has(key)) bad.add(f.id).add(seen.get(key)!);
    else seen.set(key, f.id);
  }
  return bad;
}
