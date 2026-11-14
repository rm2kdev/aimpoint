"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon, KeyRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Shows a freshly generated API key once, with copy. */
export function KeyReveal({ apiKey }: { apiKey: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-[10px] border border-live-border bg-live px-3.5 py-3">
      <p className="flex items-center gap-2 text-[13px] font-medium">
        <KeyRoundIcon className="size-3.5" /> Copy this key now. You won&rsquo;t be able to see it again.
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12.5px] select-all">{apiKey}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(apiKey);
            setCopied(true);
            toast.success("API key copied");
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
