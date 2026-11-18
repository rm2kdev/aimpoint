"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, CodeIcon, CopyIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { SettingsRow, Tag } from "@/components/settings/ui";
import { StatusRing, TypeSquare } from "@/components/bits";
import { projectStatuses } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { createProjectForm, deleteProjectForm, updateProjectForm } from "@/app/actions/forms";
import { fieldsInput, FormFieldsEditor, hasTextField, invalidFieldIds, sameFields } from "@/components/settings/form-fields-editor";
import { TYPE_LABELS } from "@/lib/format";
import { STAGE_LABELS } from "@/lib/stages";
import { isFormDestinationStage, TASK_TYPES, type FormTypeMode, type ProjectForm, type Status, type TaskType } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Public URL path of a form (the route itself is VEC-207's). */
const formPath = (publicId: string) => `/f/${encodeURIComponent(publicId)}`;

/** The page origin on the client; "" during the server render so hydration matches. */
const noop = () => () => {};
export function useOrigin() {
  return useSyncExternalStore(
    noop,
    () => location.origin,
    () => "",
  );
}

/** "Issue", "Issue or Feature", "Issue, Feature or Task". */
const orList = (words: string[]) => (words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`);

function embedSnippet(url: string, name: string) {
  const title = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<iframe src="${url}" title="${title}" width="100%" height="720" style="border:0" loading="lazy"></iframe>`;
}

/** Clipboard write that also works on plain-http LAN origins, where navigator.clipboard is undefined. */
async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string, what: string) =>
    copyText(text).then(
      () => {
        setCopied(key);
        toast.success(`${what} copied`);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
      },
      () => toast.error("Couldn't copy to the clipboard"),
    );
  return { copied, copy };
}

/**
 * External forms (VEC-204/206) on a project's settings page: public forms that file tasks into this project.
 * Admins list, create, edit, enable/disable and delete them; members only see that forms exist. `forms` comes
 * from the server render and refreshes on every save (and on org.changed from other admins).
 */
export function ProjectForms({
  projectId,
  projectName,
  archived,
  forms,
  formCount,
}: {
  projectId: string;
  projectName: string;
  archived: boolean;
  /** Admins only; null for members. */
  forms: ProjectForm[] | null;
  formCount: number;
}) {
  const { org, isAdmin, statusesByProject, billing } = useOrg();
  // Unpaid, locked org (VEC-224/262): no new forms; existing ones stay editable but show "Form unavailable" publicly.
  const formsLocked = !billing.features.publicForms;
  const router = useRouter();
  const origin = useOrigin();
  const { copied, copy } = useCopy();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<ProjectForm | "new" | null>(null);
  const [deleting, setDeleting] = useState<ProjectForm | null>(null);
  const [embedFor, setEmbedFor] = useState<string | null>(null);
  // Optimistic enabled flags while a toggle is in flight.
  const [toggling, setToggling] = useState<Record<string, boolean>>({});

  const statuses = projectStatuses(statusesByProject, projectId);
  const destinations = statuses.filter((s) => isFormDestinationStage(s.category));
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  const desc = (
    <>
      Public forms that let people outside the team, like your users, file tasks into {projectName} without an account. Each form
      picks the status submissions land in and whether the type is fixed or chosen by the submitter. Share the link or embed it on your site.
    </>
  );

  if (!isAdmin || !forms) {
    return (
      <SettingsRow id="forms" title="External forms" desc={desc}>
        <p className="text-[13px] text-muted-foreground">
          {formCount === 0 ? `${projectName} has no external forms.` : `${projectName} has ${formCount} external form${formCount === 1 ? "" : "s"}.`}
        </p>
        <p className="mt-1 text-[12.5px] text-faint">Only an admin can see and manage them.</p>
      </SettingsRow>
    );
  }

  const setEnabled = (f: ProjectForm, enabled: boolean) => {
    setToggling((t) => ({ ...t, [f.id]: enabled }));
    start(async () => {
      const r = await updateProjectForm(org.slug, f.id, { enabled });
      if (!r.ok) toast.error(r.error);
      else toast.success(enabled ? `${f.name} is taking submissions` : `${f.name} is switched off`);
      router.refresh();
      setToggling((t) => {
        const { [f.id]: _drop, ...rest } = t;
        void _drop;
        return rest;
      });
    });
  };

  const remove = (f: ProjectForm) =>
    start(async () => {
      const r = await deleteProjectForm(org.slug, f.id);
      if (!r.ok) return void toast.error(r.error);
      setDeleting(null);
      toast.success(`Deleted ${f.name}`);
      router.refresh();
    });

  return (
    <SettingsRow id="forms" title="External forms" desc={desc}>
      <div className="grid max-w-2xl gap-3">
        {formsLocked && forms.length > 0 && (
          <p data-forms-locked className="rounded-lg border border-border bg-sidebar px-3.5 py-2.5 text-[13px] text-muted-foreground">
            While the organisation is locked (no Pro subscription), these forms are kept but show &ldquo;Form unavailable&rdquo; to visitors.
          </p>
        )}
        {forms.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-input px-4 py-5 text-[13px] text-muted-foreground">
            No forms yet. Add one for bug reports into Triage, or a feedback form where people choose Issue or Feature.
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-[10px] border border-border" aria-label={`${projectName} external forms`}>
            {forms.map((f) => {
              const enabled = toggling[f.id] ?? f.enabled;
              const status = statusById.get(f.destinationStatusId);
              const path = formPath(f.publicId);
              const url = `${origin}${path}`;
              const showEmbed = embedFor === f.id;
              return (
                <li key={f.id} className="px-3.5 py-3" data-form-id={f.id}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={cn("truncate text-[13.5px] font-medium", !enabled && "text-muted-foreground")}>{f.name}</span>
                        {!enabled && <Tag>Off</Tag>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5" title="Submissions land in">
                          {status && <StatusRing status={status} statuses={statuses} size={12} />}
                          {status?.name ?? "Unknown status"}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          {f.typeMode === "fixed" ? (
                            <>
                              <TypeSquare type={f.type} className="size-1.5" />
                              Always {TYPE_LABELS[f.type]}
                            </>
                          ) : (
                            <>Submitter picks {orList(f.allowedTypes.map((t) => TYPE_LABELS[t]))}</>
                          )}
                        </span>
                        {f.richText && <span>{f.allowImages ? "Rich text and images" : "Rich text"}</span>}
                        {f.fields.length > 0 && <span>{f.fields.length === 1 ? "1 extra field" : `${f.fields.length} extra fields`}</span>}
                      </div>
                      {f.disabledReason && !f.enabled && <p className="mt-1 text-[12.5px] text-destructive">{f.disabledReason}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Switch
                        checked={enabled}
                        disabled={pending || (archived && !enabled)}
                        onCheckedChange={(v) => setEnabled(f, v)}
                        aria-label={enabled ? `Switch off ${f.name}` : `Switch on ${f.name}`}
                        className="mr-1.5"
                      />
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${f.name}`} onClick={() => setEditing(f)} disabled={pending}>
                        <PencilIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${f.name}`}
                        className="text-faint hover:text-destructive"
                        onClick={() => setDeleting(f)}
                        disabled={pending}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-sidebar px-2 py-1.5 font-mono text-[12px] text-muted-foreground" title={url}>
                      {url || path}
                    </code>
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => copy(`link:${f.id}`, url, "Link")} aria-label={`Copy link to ${f.name}`}>
                      {copied === `link:${f.id}` ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />} Copy link
                    </Button>
                    <Button
                      variant={showEmbed ? "secondary" : "ghost"}
                      size="sm"
                      className="gap-1.5"
                      aria-expanded={showEmbed}
                      onClick={() => setEmbedFor(showEmbed ? null : f.id)}
                    >
                      <CodeIcon className="size-3.5" /> Embed
                    </Button>
                  </div>
                  {showEmbed && (
                    <div className="mt-2 grid gap-1.5">
                      <Textarea
                        readOnly
                        value={embedSnippet(url, f.name)}
                        rows={2}
                        aria-label={`Embed code for ${f.name}`}
                        onFocus={(e) => e.currentTarget.select()}
                        className="resize-none font-mono text-[12px] md:text-[12px]"
                      />
                      <div className="flex items-center gap-2">
                        <p className="flex-1 text-[12.5px] text-muted-foreground">Paste this into any web page to show the form inline.</p>
                        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => copy(`embed:${f.id}`, embedSnippet(url, f.name), "Embed code")}>
                          {copied === `embed:${f.id}` ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />} Copy code
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditing("new")} disabled={archived || formsLocked || destinations.length === 0}>
            <PlusIcon className="size-3.5" /> Add form
          </Button>
          {archived && <p className="mt-1.5 text-[12.5px] text-faint">Restore the project to add forms.</p>}
        </div>
      </div>

      {editing && (
        <FormEditor
          key={editing === "new" ? "new" : editing.id}
          form={editing === "new" ? null : editing}
          projectId={projectId}
          projectName={projectName}
          destinations={destinations}
          statuses={statuses}
          onClose={() => setEditing(null)}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its link stops working straight away, including anywhere it&rsquo;s embedded. Tasks already submitted through it stay in {projectName}. To pause it
              instead, switch it off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep form</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) remove(deleting);
              }}
            >
              Delete form
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsRow>
  );
}

/** Create / edit dialog. The server re-validates everything (status of this project, allowed stage, 2+ types to choose). */
function FormEditor({
  form,
  projectId,
  projectName,
  destinations,
  statuses,
  onClose,
}: {
  form: ProjectForm | null;
  projectId: string;
  projectName: string;
  destinations: Status[];
  statuses: Status[];
  onClose: () => void;
}) {
  const { org } = useOrg();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(form?.name ?? "");
  const [intro, setIntro] = useState(form?.intro ?? "");
  const [enabled, setEnabled] = useState(form?.enabled ?? true);
  // A form whose status is no longer allowed (shouldn't happen, hooks re-map) starts with no pick.
  const firstTriage = destinations.find((s) => s.category === "triage") ?? destinations[0];
  const [statusId, setStatusId] = useState(
    form && destinations.some((s) => s.id === form.destinationStatusId) ? form.destinationStatusId : (firstTriage?.id ?? ""),
  );
  const [mode, setMode] = useState<FormTypeMode>(form?.typeMode ?? "fixed");
  const [fixedType, setFixedType] = useState<TaskType>(form?.typeMode === "fixed" ? form.type : "issue");
  const [allowed, setAllowed] = useState<TaskType[]>(form?.typeMode === "choose" ? form.allowedTypes : ["issue", "feature"]);
  const [preset, setPreset] = useState<TaskType>(form?.typeMode === "choose" ? form.type : "issue");
  const [richText, setRichText] = useState(form?.richText ?? false);
  const [allowImages, setAllowImages] = useState(form?.allowImages ?? false);
  // TPA-401: custom fields, email note, hidden description. Forms saved before TPA-399 read as none / "" / false.
  const [fields, setFields] = useState(form?.fields ?? []);
  const [emailHelp, setEmailHelp] = useState(form?.emailHelp ?? "");
  const [hideDescription, setHideDescription] = useState(form?.hideDescription ?? false);
  // The last save's refusal (UserError text), shown in the dialog; `tried` marks empty/repeated labels after it.
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const hideNow = hideDescription && hasTextField(fields);

  const allowedList = TASK_TYPES.filter((t) => allowed.includes(t));
  const presetNow = allowedList.includes(preset) ? preset : allowedList[0];
  const typeError = mode === "choose" && allowedList.length < 2 ? "Pick at least two types, or use a fixed type." : null;
  const canSave = !!name.trim() && !!statusId && !typeError && !pending;

  const toggleType = (t: TaskType, on: boolean) => setAllowed((a) => (on ? [...a.filter((x) => x !== t), t] : a.filter((x) => x !== t)));

  const save = () => {
    if (!canSave) return;
    const input = {
      name: name.trim(),
      intro: intro.trim() || null,
      enabled,
      destinationStatusId: statusId,
      typeMode: mode,
      richText,
      // Images need the rich text editor; the server refuses images without it.
      allowImages: richText && allowImages,
      ...(mode === "fixed" ? { type: fixedType, allowedTypes: [] } : { type: presetNow, allowedTypes: allowedList }),
    };
    // Sent only when they differ from what's saved, so a form that never had fields saves exactly as before.
    const note = emailHelp.replace(/\s+/g, " ").trim();
    const extrasChanged = form
      ? !sameFields(fields, form.fields) || note !== (form.emailHelp ?? "") || hideNow !== form.hideDescription
      : fields.length > 0 || !!note || hideNow;
    const extras = extrasChanged ? { fields: fieldsInput(fields), emailHelp: note || null, hideDescription: hideNow } : {};
    setError(null);
    start(async () => {
      const r = form
        ? await updateProjectForm(org.slug, form.id, { ...input, ...extras })
        : await createProjectForm(org.slug, projectId, { ...input, ...extras });
      if (!r.ok) {
        setTried(true);
        return void setError(r.error);
      }
      toast.success(form ? `Saved ${input.name}` : `Added ${input.name}`);
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-5 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{form ? `Edit ${form.name}` : "New external form"}</DialogTitle>
          <DialogDescription>Submissions become tasks in {projectName}.</DialogDescription>
        </DialogHeader>

        <form
          id="project-form-editor"
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="form-name">Name</Label>
            <Input id="form-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Bug report" maxLength={80} autoFocus />
            <p className="text-[12.5px] text-muted-foreground">Shown as the form&rsquo;s heading and on every task it files.</p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="form-intro">
              Intro <span className="font-normal text-faint">(optional)</span>
            </Label>
            <Textarea
              id="form-intro"
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              placeholder="Tell us what went wrong and how to make it happen again."
              maxLength={2000}
              rows={2}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="form-status">Submissions land in</Label>
            <Select value={statusId} onValueChange={setStatusId}>
              <SelectTrigger id="form-status" className="w-full max-w-xs" aria-label="Status submissions land in">
                <SelectValue placeholder="Pick a status" />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <StatusRing status={s} statuses={statuses} size={14} />
                    {s.name}
                    {/* The stage only when the name doesn't already say it ("Todo · Not started", not "Triage · Triage"). */}
                    {s.name.toLowerCase() !== STAGE_LABELS[s.category].toLowerCase() && <span className="text-faint">{STAGE_LABELS[s.category]}</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[12.5px] text-muted-foreground">
              Only {projectName}&rsquo;s Backlog, Triage and Not started statuses. A Triage status hands each submission to your triage bot.
            </p>
          </div>

          <fieldset className="grid gap-2.5">
            <legend className="mb-1.5 text-sm leading-none font-medium">Type</legend>
            <div role="radiogroup" aria-label="Type setting" className="inline-flex w-fit rounded-lg bg-chip p-0.5">
              {(
                [
                  ["fixed", "Fixed type"],
                  ["choose", "Submitter chooses"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={mode === v}
                  onClick={() => setMode(v)}
                  className={cn(
                    "h-7 rounded-md px-3 text-[13px] transition-colors",
                    mode === v ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === "fixed" ? (
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                Every submission is filed as
                <Select value={fixedType} onValueChange={(v) => setFixedType(v as TaskType)}>
                  <SelectTrigger size="sm" className="w-36" aria-label="Fixed type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        <TypeSquare type={t} />
                        {TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="grid gap-2.5">
                <div className="flex flex-wrap gap-x-4 gap-y-2" role="group" aria-label="Types the submitter can choose">
                  {TASK_TYPES.map((t) => (
                    <label key={t} className="inline-flex cursor-pointer items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={allowed.includes(t)}
                        onChange={(e) => toggleType(t, e.target.checked)}
                        className="size-3.5 accent-primary"
                      />
                      <TypeSquare type={t} />
                      {TYPE_LABELS[t]}
                    </label>
                  ))}
                </div>
                {typeError ? (
                  <p role="alert" className="text-[12.5px] text-destructive">
                    {typeError}
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                    Preselected
                    <Select value={presetNow} onValueChange={(v) => setPreset(v as TaskType)}>
                      <SelectTrigger size="sm" className="w-36" aria-label="Preselected type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {allowedList.map((t) => (
                          <SelectItem key={t} value={t}>
                            <TypeSquare type={t} />
                            {TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}
          </fieldset>

          <FormFieldsEditor
            fields={fields}
            onFields={setFields}
            emailHelp={emailHelp}
            onEmailHelp={setEmailHelp}
            hideDescription={hideNow}
            onHideDescription={setHideDescription}
            invalidIds={tried ? invalidFieldIds(fields) : new Set()}
          />

          <div className="grid divide-y divide-border rounded-lg border border-border">
            <label className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="leading-tight">
                <span className="block text-[13.5px] font-medium">Rich text editor</span>
                <span className="mt-0.5 block text-[12.5px] text-muted-foreground">Submitters can format the details: bold, lists, links, quotes.</span>
              </span>
              <Switch
                checked={richText}
                onCheckedChange={(v) => {
                  setRichText(v);
                  if (!v) setAllowImages(false);
                }}
                aria-label="Rich text editor"
              />
            </label>
            <label className={cn("flex items-center justify-between gap-3 px-3 py-2.5", !richText && "cursor-not-allowed")}>
              <span className="leading-tight">
                <span className={cn("block text-[13.5px] font-medium", !richText && "text-muted-foreground")}>Allow image uploads</span>
                <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                  {richText ? "Screenshots up to 5 MB each, added to the task." : "Needs the rich text editor."}
                </span>
              </span>
              <Switch checked={richText && allowImages} disabled={!richText} onCheckedChange={setAllowImages} aria-label="Allow image uploads" />
            </label>
          </div>

          <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <span className="leading-tight">
              <span className="block text-[13.5px] font-medium">Taking submissions</span>
              <span className="mt-0.5 block text-[12.5px] text-muted-foreground">Switched off, the link shows a not-found page.</span>
            </span>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Taking submissions" />
          </label>
        </form>

        {error && (
          <p role="alert" data-form-error className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="project-form-editor" disabled={!canSave}>
            {form ? "Save form" : "Add form"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
