"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useOrg } from "@/components/org-provider";
import { SettingsRow } from "@/components/settings/ui";
import { StatusRing } from "@/components/bits";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { saveDefaults } from "@/app/actions/defaults";
import { STAGE_LABELS, stageStatus } from "@/lib/stages";
import { DEFAULT_STAGES, isDefaultStage, type DefaultStage } from "@/lib/types";

const STAGE_RINGS = DEFAULT_STAGES.map(stageStatus);

/** Settings > Defaults (VEC-127/129): org-wide presets. Admins edit; members see them read-only. */
export function DefaultsSettings() {
  const { org, isAdmin, defaults } = useOrg();
  const router = useRouter();
  const [pending, start] = useTransition();
  // Optimistic value while a save is in flight; the server value (refreshed on org.changed) wins otherwise.
  const [saving, setSaving] = useState<DefaultStage | null>(null);
  const stage = saving ?? defaults.newTaskStage;

  const change = (v: string) => {
    if (!isDefaultStage(v) || v === defaults.newTaskStage) return;
    setSaving(v);
    start(async () => {
      const r = await saveDefaults(org.slug, { newTaskStage: v });
      if (!r.ok) toast.error(r.error);
      else toast.success(`New tasks start in ${STAGE_LABELS[v]}`);
      router.refresh();
      setSaving(null);
    });
  };

  return (
    <SettingsRow
      title="Default status for new tasks"
      desc={
        <>
          Where a task starts when someone creates it without picking a status. Each project uses its own status of this stage. Triage hands new
          tasks to triage bots.
        </>
      }
    >
      <div className="grid max-w-xl gap-2">
        <Select value={stage} disabled={!isAdmin || pending} onValueChange={change}>
          <SelectTrigger className="w-full max-w-xs" aria-label="Default status for new tasks">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEFAULT_STAGES.map((s) => (
              <SelectItem key={s} value={s}>
                <StatusRing status={stageStatus(s)} statuses={STAGE_RINGS} size={14} />
                {STAGE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!isAdmin && <p className="text-[12.5px] text-faint">Only an admin can change this.</p>}
      </div>
    </SettingsRow>
  );
}
