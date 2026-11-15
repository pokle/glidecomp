/** Super-admin user list — React port of admin-users.ts/admin-users.html. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/react/rac/badge";
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { Cell, Column, Row, Table, TableBody, TableHeader } from "@/react/rac/table";
import { underSettings } from "../lib/crumbs";
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

  // The bar before the data, so the page does not jump when it arrives. Wide:
  // seven columns of counts.
  const bar = <PageBar title="All users" trail={underSettings()} />;

  if (userLoading || state.kind === "loading") {
    return (
      <Page width="wide" bar={bar}>
        <Loading>Loading users…</Loading>
      </Page>
    );
  }

  if (state.kind === "error") {
    return (
      <Page width="wide" bar={bar}>
        <p className="text-sm text-muted-foreground" role="alert">
          {state.message}
        </p>
      </Page>
    );
  }

  const { users } = state;

  return (
    <Page width="wide" bar={bar} className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {users.length} registered user{users.length !== 1 ? "s" : ""}
      </p>

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
                    <Badge className="ml-2 bg-primary/10 text-link">super admin</Badge>
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
                    <span className="text-xs text-caution">
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
    </Page>
  );
}
