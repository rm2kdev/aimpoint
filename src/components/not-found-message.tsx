"use client";

import Link from "next/link";
import { useOrgBase } from "@/components/org-provider";
import { Button } from "@/components/ui/button";
import { orgPath } from "@/lib/paths";

/** The 404 body, shared by the app-level and in-shell (org) not-found pages. */
export function NotFoundMessage({ href, label }: { href: string; label: string }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-[18vh] text-center">
      <p className="mb-3 font-mono text-[13px] text-faint">404</p>
      <h1 className="text-[15px] font-semibold">Page not found</h1>
      <p className="mt-1 text-[13.5px] text-muted-foreground">
        This page doesn&apos;t exist, or you don&apos;t have access to it.
      </p>
      <Button asChild variant="outline" className="mt-5">
        <Link href={href}>{label}</Link>
      </Button>
    </div>
  );
}

/** In-shell 404 for pages under an organisation: keeps the sidebar and links back to My Tasks. */
export function OrgNotFoundMessage() {
  const { org } = useOrgBase();
  return <NotFoundMessage href={orgPath(org.slug, "my")} label="Go to My Tasks" />;
}
