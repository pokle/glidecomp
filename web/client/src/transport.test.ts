import { describe, expect, it } from "bun:test";
import { guardWrites, WriteBlockedError } from "./transport";

const ok = () => Promise.resolve(new Response("{}"));

describe("guardWrites", () => {
  it("passes every request through when writes are allowed", async () => {
    const f = guardWrites(ok, true);
    expect((await f("https://glidecomp.com/api/comp", { method: "POST" })).ok).toBe(true);
  });

  it("lets reads through when writes are blocked", async () => {
    const f = guardWrites(ok, false);
    expect((await f("https://glidecomp.com/api/comp")).ok).toBe(true);
    expect((await f("https://glidecomp.com/api/comp", { method: "head" })).ok).toBe(true);
  });

  it("refuses every write when writes are blocked, without sending it", async () => {
    let sent = 0;
    const f = guardWrites(() => {
      sent++;
      return ok();
    }, false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      await expect(f("https://glidecomp.com/api/comp", { method })).rejects.toBeInstanceOf(
        WriteBlockedError
      );
    }
    await expect(
      f(new Request("https://glidecomp.com/api/comp", { method: "DELETE" }))
    ).rejects.toBeInstanceOf(WriteBlockedError);
    expect(sent).toBe(0);
  });
});
