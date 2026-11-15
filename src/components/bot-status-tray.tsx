"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useOrg } from "@/components/org-provider";
import { BotAvatar } from "@/components/bits";
import { BOT_MAX_TASKS_DEFAULT } from "@/lib/types";
import { orgPath } from "@/lib/paths";
import { cn } from "@/lib/utils";

/**
 * A slim bar pinned to the bottom of the app listing the bots that are working right now, each as
 * avatar + name + `active/max` (VEC-30). Counts come live from useOrg().activeByBot (VEC-29) and the
 * max from the bot's maxTasks setting (VEC-28). Idle bots are hidden. Clicking a bot opens its detail
 * page in settings, whose Work section lists the tasks it holds.
 *
 * Overflow scrolls horizontally (never wraps), with a fade on whichever edge has more to show.
 */
export function BotStatusTray() {
  const { org, members, activeByBot } = useOrg();

  const working = useMemo(
    () =>
      members
        .filter((m) => m.kind === "bot" && (activeByBot.get(m.id) ?? 0) > 0)
        .map((m) => ({ bot: m, active: activeByBot.get(m.id) ?? 0, max: m.maxTasks ?? BOT_MAX_TASKS_DEFAULT }))
        .sort((a, b) => a.bot.name.localeCompare(b.bot.name, undefined, { sensitivity: "base" })),
    [members, activeByBot],
  );

  const scroller = useRef<HTMLUListElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () =>
      setFade((cur) => {
        const left = el.scrollLeft > 1;
        const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
        return cur.left === left && cur.right === right ? cur : { left, right };
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [working.length]);

  const mask =
    fade.left || fade.right
      ? `linear-gradient(to right, ${fade.left ? "transparent, #000 24px" : "#000"}, ${fade.right ? "#000 calc(100% - 24px), transparent" : "#000"})`
      : undefined;

  return (
    <footer
      aria-label="Bot status"
      data-bot-status-tray
      className="flex h-[30px] shrink-0 items-center gap-3 border-t border-sidebar-border bg-sidebar pl-3 pr-2 text-[12.5px] text-sidebar-foreground"
    >
      <span className="shrink-0 text-[11.5px] font-medium text-faint">
        Bots
        {working.length > 0 && <span className="tabular ml-1.5 font-mono text-[11.5px]">{working.length}</span>}
      </span>
      {working.length === 0 ? (
        <span className="truncate text-[12px] text-faint" data-empty>
          No bots working
        </span>
      ) : (
        <ul
          ref={scroller}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        >
          {working.map(({ bot, active, max }) => {
            const full = active >= max;
            const over = active > max;
            const label = `${bot.name}: working on ${active} of ${max} task${max === 1 ? "" : "s"}${over ? ", over capacity" : full ? ", at capacity" : ""}`;
            return (
              <li key={bot.id} className="shrink-0">
                <Link
                  href={orgPath(org.slug, "settings", "bots", bot.id)}
                  aria-label={label}
                  title={label}
                  data-bot-id={bot.id}
                  data-full={full || undefined}
                  className="flex h-[22px] items-center gap-1.5 rounded-[7px] px-1.5 transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
                >
                  <BotAvatar avatar={bot.avatar} name={bot.name} size={16} className="pointer-events-none" />
                  <span className="max-w-[200px] truncate">{bot.name}</span>
                  <span
                    className={cn(
                      "tabular rounded-[5px] font-mono text-[11.5px]",
                      over
                        ? "bg-destructive/10 px-1 font-medium text-destructive"
                        : full
                          ? "bg-muted px-1 font-medium text-foreground ring-1 ring-input ring-inset"
                          : "text-faint",
                    )}
                  >
                    {active}/{max}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </footer>
  );
}
