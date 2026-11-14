"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Counts, Member, Project, Status } from "@/lib/types";
import type { RealtimeEvent } from "@/lib/realtime/events";
import { getCounts } from "@/app/actions/tasks";

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
}

interface Ctx {
  org: OrgInfo;
  orgs: OrgInfo[];
  me: Me;
  isAdmin: boolean;
  members: Member[];
  memberById: Map<string, Member>;
  projects: Project[];
  projectById: Map<string, Project>;
  statuses: Status[];
  statusById: Map<string, Status>;
  counts: Counts;
  subscribe: (fn: (e: RealtimeEvent) => void) => () => void;
  connected: boolean;
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
  projects,
  statuses,
  counts: initialCounts,
  realtime,
  children,
}: {
  org: OrgInfo;
  orgs: OrgInfo[];
  me: Me;
  members: Member[];
  projects: Project[];
  statuses: Status[];
  counts: Counts;
  realtime: { driver: "local" | "pusher"; key?: string; cluster?: string };
  children: React.ReactNode;
}) {
  const router = useRouter();
  const listeners = useRef(new Set<(e: RealtimeEvent) => void>());
  const [connected, setConnected] = useState(false);
  const [counts, setCounts] = useState(initialCounts);
  useEffect(() => setCounts(initialCounts), [initialCounts]);

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
      if (e.type === "org.changed") router.refresh();
      if (e.type === "task.upsert" || e.type === "task.delete") refreshCounts();
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
        cleanup = () => {
          ch.unbind_all();
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
  }, [org.id, realtime.driver, realtime.key, realtime.cluster, router, refreshCounts]);

  const value = useMemo<Ctx>(
    () => ({
      org,
      orgs,
      me,
      isAdmin: me.role === "admin",
      members,
      memberById: new Map(members.map((m) => [m.id, m])),
      projects,
      projectById: new Map(projects.map((p) => [p.id, p])),
      statuses,
      statusById: new Map(statuses.map((s) => [s.id, s])),
      counts,
      subscribe,
      connected,
    }),
    [org, orgs, me, members, projects, statuses, counts, subscribe, connected],
  );
  return <OrgCtx.Provider value={value}>{children}</OrgCtx.Provider>;
}
