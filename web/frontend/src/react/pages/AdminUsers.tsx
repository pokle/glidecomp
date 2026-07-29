/** Super-admin user list — React port of admin-users.ts/admin-users.html. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/react/rac/badge";
import { Cell, Column, Row, Table, TableBody, TableHeader } from "@/react/rac/table";
import { useGoToSignIn, useUser } from "../lib/user";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  email_verified: boolean;
  created_at: string;
  is_super_admin: boolean;
  track_count: number;
  task_count: number;
  admin_comp_count: number;
  pilot_comp_count: number;
}

export function AdminUsers() {
  const { user, loading: userLoading } = useUser();
  const goToSignIn = useGoToSignIn();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; users: AdminUser[] }
  >({ kind: "loading" });

  useEffect(() => {
    document.title = "GlideComp - Admin: Users";
  }, []);

  useEffect(() => {
    if (userLoading) return;
    if (!user) {
      goToSignIn(window.location.pathname);
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/admin/users", { credentials: "include" });
        if (res.status === 403) {
          setState({ kind: "error", message: "You don't have access to this page." });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error", message: "Failed to load users." });
          return;
        }
        const data = (await res.json()) as { users: AdminUser[] };
        setState({ kind: "ready", users: data.users });
      } catch {
        setState({ kind: "error", message: "Network error loading users." });
      }
    })();
  }, [user, userLoading, goToSignIn]);

  if (userLoading || state.kind === "loading") {
    return (
      <div className="py-8 animate-pulse space-y-4" role="status" aria-label="Loading users">
        <div className="h-8 w-48 rounded-md bg-muted" />
        <div className="h-64 rounded-lg bg-muted" />
        <span className="sr-only">Loading users…</span>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-muted-foreground" role="alert">
          {state.message}
        </p>
      </div>
    );
  }

  const { users } = state;

  return (
    <section className="mx-auto w-full max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">All Users</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {users.length} registered user{users.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* scrollLabel: seven columns overflow on anything narrow, and without a
          focusable scroll region a keyboard-only admin can never reach the
          right-hand counts (WCAG 2.1.1). The kit's Table owns the wrapper. */}
      <Table aria-label="All users" scrollLabel="All users">
        <TableHeader>
          <Column isRowHeader>User</Column>
          <Column>Email</Column>
          <Column>Joined</Column>
          <Column className="text-right">Tracks</Column>
          <Column className="text-right">Tasks</Column>
          <Column className="text-right">Admin of</Column>
          <Column className="text-right">Pilot in</Column>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <Row key={u.id} id={u.id}>
              <Cell>
                <div className="font-medium">
                  {u.name}
                  {u.is_super_admin ? (
                    <Badge className="ml-2 bg-primary/10 text-primary">super admin</Badge>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {u.username ? (
                    <Link to={`/u/${encodeURIComponent(u.username)}`} className="hover:underline">
                      @{u.username}
                    </Link>
                  ) : (
                    <span className="italic">no username</span>
                  )}
                </div>
              </Cell>
              <Cell className="text-muted-foreground">
                {u.email}
                {u.email_verified ? null : (
                  <>
                    {" "}
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      (unverified)
                    </span>
                  </>
                )}
              </Cell>
              <Cell className="text-muted-foreground whitespace-nowrap">
                {new Date(u.created_at).toLocaleDateString()}
              </Cell>
              <Cell className="text-right tabular-nums">{u.track_count}</Cell>
              <Cell className="text-right tabular-nums">{u.task_count}</Cell>
              <Cell className="text-right tabular-nums">{u.admin_comp_count}</Cell>
              <Cell className="text-right tabular-nums">{u.pilot_comp_count}</Cell>
            </Row>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
