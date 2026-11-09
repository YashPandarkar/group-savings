import { Link } from "react-router-dom";
import { EmptyState, PageHeader } from "../components/ui";

export function ComingSoon({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title="This page is built in the next part of Phase 11." />
    </>
  );
}

export function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
      <p className="text-lg font-semibold">Page not found</p>
      <Link to="/" className="text-indigo-600">Go to the dashboard</Link>
    </div>
  );
}
