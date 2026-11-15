"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { signOutOtherSessions } from "@/app/actions/account";

/** One button: every other browser and device is signed out on its next request; this one stays. */
export function SessionsForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="grid max-w-md gap-3">
      <div>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await signOutOtherSessions().catch(() => null);
              if (!r) return setError("Couldn't reach the server. Try again.");
              if (!r.ok) return setError(r.error);
              setError(null);
              toast.success("Signed out of every other session.");
            })
          }
        >
          {pending ? "Signing out…" : "Sign out of all other sessions"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
