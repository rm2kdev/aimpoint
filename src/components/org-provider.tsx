"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BotWorkload, Counts, Member, Project, Status, WorkloadSnapshot } from "@/lib/types";
import type { RealtimeEvent } from "@/lib/realtime/events";
import { getCounts } from "@/app/actions/tasks";
import { getUnreadCount } from "@/app/actions/notifications";
import { reorderProjectsAction } from "@/app/actions/project-order";
import { sortByProjectOrder, type ProjectOrder } from "@/lib/project-order";
import type { Result } from "@/lib/result";

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
  statuses: Status[];
  statusById: Map<string, Status>;
  counts: Counts;
  /** Unread notifications for the signed-in person. */
  unread: number;
  setUnread: (fn: (n: number) => number) => void;
  subscribe: (fn: (e: RealtimeEvent) => void) => () => void;
  connected: boolean;
  /** Members who currently have this organisation open. */
  online: string[];
  /** Live per-bot active task counts (every bot in the org; see loadBotWorkload). */
  workload: BotWorkload[];
  /** Active task count by bot id; 0 for bots not in the map. */
  activeByBot: Map<string, number>;
}

const OrgCtx = createContext<Ctx | null>(null);

export function useOrg() {
  const c = useContext(OrgCtx);
  if (!c) throw new Error("useOrg outside OrgProvider");
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
  statuses,
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

  // Count refresh + shell refresh, debounced.
  const countTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshCounts = useCallback(() => {
    clearTimeout(countTimer.current);
    countTimer.current = setTimeout(async () => {
      const r = await getCounts(org.slug);
      if (r.ok && r.data) setCounts(r.data);
    }, 400);
  }, [org.slug]);

  useEffect(() => {
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
  }, [org.id, org.slug, me.id, realtime.driver, realtime.key, realtime.cluster, router, refreshCounts]);

  const value = useMemo<Ctx>(
    () => ({
      org,
      orgs,
      me,
      isAdmin: me.role === "admin",
      members,
      memberById: new Map([...(deletedMembers ?? []), ...members].map((m) => [m.id, m])),
      projects,
      projectById: new Map(projects.map((p) => [p.id, p])),
      reorderProjects,
      statuses,
      statusById: new Map(statuses.map((s) => [s.id, s])),
      counts,
      unread,
      setUnread,
      subscribe,
      connected,
      online,
      workload: workloadSnap.bots,
      activeByBot: new Map(workloadSnap.bots.map((b) => [b.botId, b.active])),
    }),
    [org, orgs, me, members, deletedMembers, projects, reorderProjects, statuses, counts, unread, setUnread, subscribe, connected, online, workloadSnap],
  );
  return <OrgCtx.Provider value={value}>{children}</OrgCtx.Provider>;
}
