"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { acceptInvite } from "@/app/actions/org";

export function AcceptInvite({ token, as }: { token: string; as: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const router = useRouter();
  return (
    <div className="mt-6">
      <Button
        className="h-9 w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await acceptInvite(token);
            if (!r.ok) return setError(r.error);
            router.push(`/${r.data!.slug}/my`);
          })
        }
      >
        {pending ? "Joining…" : "Accept invite"}
      </Button>
      <p className="mt-3 text-[13px] text-faint">Signed in as {as}</p>
      <p role="alert" aria-live="polite" className="mt-2 text-[13px] text-destructive">{error}</p>
    </div>
  );
}
