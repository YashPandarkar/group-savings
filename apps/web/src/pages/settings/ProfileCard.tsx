import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { useAuth } from "../../auth/AuthContext";
import { Button, Card, TextField } from "../../components/ui";
import { useToast } from "../../components/Toast";
import { api, errorMessage } from "../../lib/api";

const nameSchema = z.string().trim().min(2, "Enter your name").max(80);

export default function ProfileCard() {
  const { me, reload } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(me!.user.name);
  const [error, setError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (value: string) => api("/api/auth/profile", { method: "PATCH", body: { name: value } }),
    onSuccess: async () => {
      await reload();
      toast.success("Profile updated.");
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = nameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    setError(undefined);
    save.mutate(parsed.data);
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Profile</h2>
      <form onSubmit={onSubmit} className="mt-4 max-w-md space-y-4" noValidate>
        <TextField label="Full name" name="profile-name" value={name} onChange={setName} error={error} />
        <TextField label="Email" name="profile-email" value={me!.user.email} onChange={() => undefined} disabled hint="Your email can't be changed here." />
        <Button type="submit" loading={save.isPending} disabled={name.trim() === me!.user.name}>Save profile</Button>
      </form>
    </Card>
  );
}
