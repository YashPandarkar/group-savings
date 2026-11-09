import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, EmptyState, PageHeader, Spinner } from "../components/ui";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/format";

type Notice = { id: string; type: string; title: string; body: string; readAt: string | null; createdAt: string };
type Page = { page: number; pageSize: number; total: number; unread: number; items: Notice[] };

const PAGE_SIZE = 20;

export default function Notifications() {
  const [page, setPage] = useState(1);
  const qc = useQueryClient();
  const toast = useToast();

  const list = useQuery({
    queryKey: ["notifications", page],
    queryFn: () => api<Page>(`/api/notifications?page=${page}&pageSize=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["notifications"] });
    void qc.invalidateQueries({ queryKey: ["notifications-unread"] });
  }

  const markOne = useMutation({
    mutationFn: (id: string) => api(`/api/notifications/${id}/read`, { method: "POST" }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const markAll = useMutation({
    mutationFn: () => api("/api/notifications/read-all", { method: "POST" }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });

  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={data ? `${data.unread} unread` : undefined}
        action={
          data && data.unread > 0 ? (
            <Button variant="secondary" loading={markAll.isPending} onClick={() => markAll.mutate()}>Mark all as read</Button>
          ) : undefined
        }
      />

      {list.isPending && <Spinner />}
      {list.isError && <Alert kind="error">{errorMessage(list.error)}</Alert>}
      {data && data.items.length === 0 && <EmptyState title="You're all caught up" >Nothing to show yet.</EmptyState>}

      {data && data.items.length > 0 && (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {data.items.map((n) => (
            <li key={n.id} className={`flex items-start gap-3 px-4 py-4 ${n.readAt ? "" : "bg-indigo-50/50"}`}>
              <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${n.readAt ? "bg-transparent" : "bg-indigo-600"}`} aria-label={n.readAt ? "Read" : "Unread"} />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900">{n.title}</p>
                <p className="mt-0.5 text-sm text-slate-600">{n.body}</p>
                <p className="mt-1 text-xs text-slate-400">{formatDateTime(n.createdAt)}</p>
              </div>
              {!n.readAt && (
                <button type="button" onClick={() => markOne.mutate(n.id)} className="shrink-0 text-xs font-medium text-indigo-600 hover:underline">
                  Mark as read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {data && pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-slate-600">Page {page} of {pages}</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </>
  );
}
