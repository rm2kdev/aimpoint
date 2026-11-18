"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BotWorkload, Counts, Member, OrgDefaults, Project, Status, WorkloadSnapshot } from "@/lib/types";
import type { ResolvedFlow } from "@/lib/flow-model";
import { UNLIMITED_SUMMARY, type BillingSummary } from "@/lib/billing-view";
import type { RealtimeEvent } from "@/lib/realtime/events";
import { getCounts } from "@/app/actions/tasks";
import { getUnreadCount } from "@/app/actions/notifications";
import { reorderProjectsAction } from "@/app/actions/project-order";
import { sortByProjectOrder, type ProjectOrder } from "@/lib/project-order";
import type { Result } from "@/lib/result";
import { isDragActive } from "@/components/ui/drag-provider";

export interface OrgInfo {
  id: string;
  name: string;
  slug: string;
}
export interface Me {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  image?: string | null;
}

interface Ctx {
  org: OrgInfo;
  orgs: OrgInfo[];
  me: Me;
  isAdmin: boolean;
  members: Member[];
  memberById: Map<string, Member>;
  /** Every project (archived too), in the signed-in person's own sidebar order (see lib/project-order). */
  projects: Project[];
  projectById: Map<string, Project>;
  /**
   * Save a new project order for the signed-in person (ids top first; archived/unknown ids are dropped
   * server-side, unlisted projects go after in createdAt order). Applied here at once, rolled back if the
   * server refuses; their other tabs follow through a `projects.order` event.
   */
  reorderProjects: (projectIds: string[]) => Promise<Result<ProjectOrder>>;
  /** Every project's statuses (VEC-114: statuses belong to a project). Prefer `statusesByProject`. */
  statuses: Status[];
  statusById: Map<string, Status>;
  /** Each project's statuses in workflow order (VEC-117). A task only ever takes its own project's. */
  statusesByProject: Map<string, Status[]>;
  /** Org-wide defaults with presets filled in (VEC-128), refreshed with the layout on org.changed. */
  defaults: OrgDefaults;
  /**
   * Each project's flow, for the task stepper and row step chips (VEC-178). Only projects whose flow names an
   * owner or instructions (lib/flow-view.ts); refreshed with the layout on org.changed.
   */
  flowByProject: Map<string, ResolvedFlow>;
  counts: Counts;
  /** Unread notifications for the signed-in person. */
  unread: number;
  setUnread: (fn: (n: number) => number) => void;
  subscribe: (fn: (e: RealtimeEvent) => void) => () => void;
  connected: boolean;
  /** Members who currently have this organisation open. */
  online: string[];
  /**
   * The org's plan, lock state and seats (VEC-226, paid-only since VEC-262), refreshed with the layout on org.changed (Stripe webhooks publish
   * one). With billing off it is UNLIMITED_SUMMARY: no prompts anywhere.
   */
  billing: BillingSummary;
  /** Live per-bot active task counts (every bot in the org; see loadBotWorkload). */
  workload: BotWorkload[];
  /** Active task count by bot id; 0 for bots not in the map. */
  activeByBot: Map<string, number>;
}

/**
 * The parts of the org context that change only on navigation or an org change, not with live counts or the
 * sidebar's project order (a reorder would otherwise re-render every task row through `projectById`, VEC-74).
 * `projectById` is keyed by id, so it keeps its identity when only the order changes.
 */
export type OrgBase = Omit<
  Ctx,
  "counts" | "unread" | "setUnread" | "connected" | "online" | "workload" | "activeByBot" | "projects" | "reorderProjects" | "billing"
>;

const OrgCtx = createContext<Ctx | null>(null);
const OrgBaseCtx = createContext<OrgBase | null>(null);

export function useOrg() {
  const c = useContext(OrgCtx);
  if (!c) throw new Error("useOrg outside OrgProvider");
  return c;
}

/**
 * Like `useOrg`, without the live values (counts, unread, presence, bot workload). Components rendered per
 * task row use this, so a count refresh or someone coming online doesn't re-render every row (VEC-73).
 */
export function useOrgBase() {
  const c = useContext(OrgBaseCtx);
  if (!c) throw new Error("useOrgBase outside OrgProvider");
  return c;
}

/** Subscribe to every real-time event for the current organisation. */
export function useOrgEvents(handler: (e: RealtimeEvent) => void) {
  const { subscribe } = useOrg();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

export function OrgProvider({
  org,
  orgs,
  me,
  members,
  deletedMembers,
  projects: serverProjects,
  projectOrder: serverOrder,
  statuses: serverStatuses,
  defaults: serverDefaults,
  flows: serverFlows,
  billing: serverBilling,
  counts: initialCounts,
  unread: initialUnread,
  workload: initialWorkload,
  realtime,
  children,
}: {
  org: OrgInfo;
  orgs: OrgInfo[];
  me: Me;
  members: Member[];
  /** Deleted accounts ("Deleted user"): resolvable through memberById, never offered in pickers. */
  deletedMembers?: Member[];
  projects: Project[];
  projectOrder: ProjectOrder;
  statuses: Status[];
  defaults: OrgDefaults;
  flows?: Record<string, ResolvedFlow>;
  billing?: BillingSummary;
  counts: Counts;
  unread: number;
  workload: WorkloadSnapshot;
  realtime: { driver: "local" | "pusher"; key?: string; cluster?: string };
  children: React.ReactNode;
}) {
  const router = useRouter();
  const listeners = useRef(new Set<(e: RealtimeEvent) => void>());
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState<string[]>([]);
  const [counts, setCounts] = useState(initialCounts);
  useEffect(() => setCounts(initialCounts), [initialCounts]);
  const [unread, setUnreadState] = useState(initialUnread);
  useEffect(() => setUnreadState(initialUnread), [initialUnread]);
  // Server render (layout, refreshed on org.changed) and live bots.workload events both feed this; whichever
  // snapshot is newer (`at`) wins, so a slow RSC refresh can't roll back a newer live count.
  const [workloadSnap, setWorkloadSnap] = useState(initialWorkload);
  const [seenWorkload, setSeenWorkload] = useState(initialWorkload);
  if (seenWorkload !== initialWorkload) {
    // New server snapshot: adjust during render (no effect), keeping a newer live one.
    setSeenWorkload(initialWorkload);
    if (initialWorkload.at >= workloadSnap.at) setWorkloadSnap(initialWorkload);
  }
  // Project order: the server render (layout, refreshed on org.changed) and this person's own reorders
  // (this tab optimistically, other tabs via projects.order) both feed it; the newer `at` wins, so a slow
  // RSC refresh can't roll back a newer order. A pending reorder in this tab outranks everything.
  const [liveOrder, setLiveOrder] = useState<ProjectOrder | null>(null);
  const liveOrderRef = useRef(liveOrder);
  useEffect(() => {
    liveOrderRef.current = liveOrder;
  });
  const projects = useMemo(
    () => (liveOrder && liveOrder.at > serverOrder.at ? sortByProjectOrder(serverProjects, liveOrder.ids) : serverProjects),
    [liveOrder, serverOrder.at, serverProjects],
  );
  const reorderProjects = useCallback(
    async (projectIds: string[]): Promise<Result<ProjectOrder>> => {
      const before = liveOrderRef.current;
      const pending: ProjectOrder = { ids: projectIds, at: Number.MAX_SAFE_INTEGER };
      liveOrderRef.current = pending;
      setLiveOrder(pending);
      const r = await reorderProjectsAction(org.slug, projectIds).catch(
        (): Result<ProjectOrder> => ({ ok: false, error: "Couldn't save the project order. Try again." }),
      );
      // A later reorder in this tab replaced ours meanwhile: leave it to settle.
      setLiveOrder((cur) => (cur !== pending ? cur : r.ok && r.data ? r.data : before));
      return r;
    },
    [org.slug],
  );
  const setUnread = useCallback((fn: (n: number) => number) => setUnreadState((n) => Math.max(0, fn(n))), []);

  const subscribe = useCallback((fn: (e: RealtimeEvent) => void) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  // Count refresh + shell refresh, debounced. Held while a drag is in progress (teammates' edits arriving
  // mid-drag would otherwise fire a server action and re-render the shell under the pointer, VEC-73).
  const countTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshCounts = useCallback(() => {
    clearTimeout(countTimer.current);
    const run = async () => {
      if (isDragActive()) return void (countTimer.current = setTimeout(run, 400));
      const r = await getCounts(org.slug);
      if (r.ok && r.data) setCounts(r.data);
    };
    countTimer.current = setTimeout(run, 400);
  }, [org.slug]);

  // VEC-263: a locked (unpaid) org opens no realtime connection: the server refuses its channels anyway, and a Pusher
  // connection costs money even when no channel is authorised. Subscribing reloads the page (Checkout return).
  const realtimeOff = !!serverBilling?.locked;
  useEffect(() => {
    if (realtimeOff) return;
    const dispatch = (e: RealtimeEvent) => {
      if (e.type === "presence") return setOnline(e.userIds);
      if (e.type === "bots.workload") {
        const snap: WorkloadSnapshot = { at: e.at, bots: e.bots };
        setWorkloadSnap((cur) => (snap.at >= cur.at ? snap : cur));
      }
      if (e.type === "org.changed") router.refresh();
      if (e.type === "projects.order") {
        if (e.userId !== me.id) return; // someone else's sidebar
        const next: ProjectOrder = { ids: e.projectIds, at: e.at };
        setLiveOrder((cur) => (!cur || next.at > cur.at ? next : cur));
      }
      if (e.type === "task.upsert" || e.type === "task.delete") refreshCounts();
      if (e.type === "notification" || e.type === "notifications.read") {
        if (e.userId !== me.id) return; // someone else's inbox
        if (e.type === "notification") setUnreadState((n) => n + 1);
        // Read in this tab or another one: take the server's count.
        else getUnreadCount(org.slug).then((r) => r.ok && r.data !== undefined && setUnreadState(r.data));
      }
      listeners.current.forEach((fn) => fn(e));
    };

    if (realtime.driver === "pusher" && realtime.key) {
      let cancelled = false;
      let cleanup = () => {};
      import("pusher-js").then(({ default: Pusher }) => {
        if (cancelled) return;
        const client = new Pusher(realtime.key!, {
          cluster: realtime.cluster ?? "mt1",
          channelAuthorization: { endpoint: "/api/realtime/pusher-auth", transport: "ajax" },
        });
        const ch = client.subscribe(`private-org-${org.id}`);
        ch.bind("event", dispatch);
        client.connection.bind("state_change", ({ current }: { current: string }) => setConnected(current === "connected"));
        type Members = { each: (fn: (m: { id: string }) => void) => void };
        const pres = client.subscribe(`presence-org-${org.id}`);
        const sync = () => {
          const ids: string[] = [];
          ((pres as unknown as { members: Members }).members).each((m) => ids.push(m.id));
          setOnline(ids);
        };
        pres.bind("pusher:subscription_succeeded", sync);
        pres.bind("pusher:member_added", sync);
        pres.bind("pusher:member_removed", sync);
        cleanup = () => {
          ch.unbind_all();
          pres.unbind_all();
          client.unsubscribe(`presence-org-${org.id}`);
          client.unsubscribe(`private-org-${org.id}`);
          client.disconnect();
        };
      });
      return () => {
        cancelled = true;
        cleanup();
      };
    }

    const es = new EventSource(`/api/realtime?org=${org.id}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        dispatch(JSON.parse(m.data));
      } catch {}
    };
    return () => es.close();
  }, [org.id, org.slug, me.id, realtime.driver, realtime.key, realtime.cluster, router, refreshCounts, realtimeOff]);

  // Statuses keep their identity across server refreshes that didn't change them (every org.changed refreshes
  // the layout), so OrgBase, and with it every task row, re-renders only when a status really changed.
  const statusSig = JSON.stringify(serverStatuses);
  const [stable, setStable] = useState({ sig: statusSig, statuses: serverStatuses });
  if (stable.sig !== statusSig) setStable({ sig: statusSig, statuses: serverStatuses });
  const statuses = stable.statuses;
  const statusMaps = useMemo(() => {
    const byProject = new Map<string, Status[]>();
    for (const s of [...statuses].sort((a, b) => a.order - b.order)) {
      const list = byProject.get(s.projectId);
      if (list) list.push(s);
      else byProject.set(s.projectId, [s]);
    }
    return { byId: new Map(statuses.map((s) => [s.id, s])), byProject };
  }, [statuses]);

  // From the server's list, not the ordered one: a reorder keeps the same map (and the same OrgBase).
  const projectById = useMemo(() => new Map(serverProjects.map((p) => [p.id, p])), [serverProjects]);
  // Keyed on the value, so an org.changed refresh that didn't touch the defaults keeps OrgBase's identity.
  const newTaskStage = serverDefaults.newTaskStage;
  const defaults = useMemo<OrgDefaults>(() => ({ newTaskStage }), [newTaskStage]);
  // Same value-keyed trick as statuses: an org.changed refresh that didn't touch a flow keeps OrgBase's identity.
  const flowSig = JSON.stringify(serverFlows ?? {});
  const [stableFlows, setStableFlows] = useState({ sig: flowSig, flows: serverFlows ?? {} });
  if (stableFlows.sig !== flowSig) setStableFlows({ sig: flowSig, flows: serverFlows ?? {} });
  const flowByProject = useMemo(() => new Map(Object.entries(stableFlows.flows)), [stableFlows]);
  // Value-keyed too, so an org.changed refresh that didn't change the plan or usage keeps the context value.
  const billingSig = JSON.stringify(serverBilling ?? UNLIMITED_SUMMARY);
  const [stableBilling, setStableBilling] = useState({ sig: billingSig, billing: serverBilling ?? UNLIMITED_SUMMARY });
  if (stableBilling.sig !== billingSig) setStableBilling({ sig: billingSig, billing: serverBilling ?? UNLIMITED_SUMMARY });
  const billing = stableBilling.billing;
  const base = useMemo<OrgBase>(
    () => ({
      org,
      orgs,
      me,
      isAdmin: me.role === "admin",
      members,
      memberById: new Map([...(deletedMembers ?? []), ...members].map((m) => [m.id, m])),
      projectById,
      statuses,
      statusById: statusMaps.byId,
      statusesByProject: statusMaps.byProject,
      defaults,
      flowByProject,
      subscribe,
    }),
    [org, orgs, me, members, deletedMembers, projectById, statuses, statusMaps, defaults, flowByProject, subscribe],
  );
  const value = useMemo<Ctx>(
    () => ({
      ...base,
      projects,
      reorderProjects,
      billing,
      counts,
      unread,
      setUnread,
      connected,
      online,
      workload: workloadSnap.bots,
      activeByBot: new Map(workloadSnap.bots.map((b) => [b.botId, b.active])),
    }),
    [base, projects, reorderProjects, billing, counts, unread, setUnread, connected, online, workloadSnap],
  );
  return (
    <OrgBaseCtx.Provider value={base}>
      <OrgCtx.Provider value={value}>{children}</OrgCtx.Provider>
    </OrgBaseCtx.Provider>
  );
}
