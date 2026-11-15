"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateDisplayName } from "@/app/actions/account";

export function ProfileForm({ name: saved, email }: { name: string; email: string }) {
  const [name, setName] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const unchanged = name.trim() === saved;

  return (
    <div className="grid max-w-md gap-5">
      <form
        className="grid gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await updateDisplayName(name);
            if (!r.ok) {
              setError(r.error);
              return;
            }
            setError(null);
            if (r.data) setName(r.data.name);
            toast.success("Name updated");
            router.refresh();
          });
        }}
      >
        <Label htmlFor="account-name" className="text-[13px]">Name</Label>
        <div className="flex gap-2">
          <Input
            id="account-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            maxLength={80}
            autoComplete="name"
            aria-invalid={!!error}
            aria-describedby={error ? "account-name-error" : undefined}
          />
          <Button type="submit" variant="outline" disabled={pending || unchanged}>
            Save
          </Button>
        </div>
        {error && (
          <p id="account-name-error" role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        )}
      </form>
      <div className="grid gap-1.5">
        <Label htmlFor="account-email" className="text-[13px]">Email</Label>
        <Input id="account-email" value={email} readOnly disabled />
        <p className="text-[12px] text-faint">Used to sign in. It can&rsquo;t be changed yet.</p>
      </div>
    </div>
  );
}
