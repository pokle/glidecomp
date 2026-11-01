import { describe, expect, it } from "vitest";
import { readRefusal } from "./form";

const response = (status: number, body: string) => ({ status, text: async () => body });

describe("readRefusal", () => {
  it("reads the standard shape, and keeps the field", async () => {
    expect(
      await readRefusal(
        response(409, JSON.stringify({
          error: "Tushar Pokle is already registered with this email.",
          field: "registered_pilot_email",
        }))
      )
    ).toEqual({
      message: "Tushar Pokle is already registered with this email.",
      field: "registered_pilot_email",
    });
  });

  it("drops a validation message's field prefix, which only repeats the label", async () => {
    expect(
      await readRefusal(
        response(400, JSON.stringify({
          error: "registered_pilot_email: Invalid email address",
          field: "registered_pilot_email",
        }))
      )
    ).toEqual({ message: "Invalid email address", field: "registered_pilot_email" });
  });

  it("keeps a prefix it cannot attribute to the field", async () => {
    expect(await readRefusal(response(400, JSON.stringify({ error: "pilots.3: Bad" }))))
      .toEqual({ message: "pilots.3: Bad", field: undefined });
  });

  it("joins the bulk route's per-row errors", async () => {
    const body = JSON.stringify({ errors: [{ index: 0, error: "One." }, { index: 2, error: "Two." }] });
    expect(await readRefusal(response(400, body))).toEqual({ message: "One. Two." });
  });

  it("passes readable text through, and never an HTML page", async () => {
    expect(await readRefusal(response(502, "Bad gateway"))).toEqual({ message: "Bad gateway" });
    expect(await readRefusal(response(502, "<!doctype html><html>…"))).toEqual({
      message: "Save failed (502).",
    });
    expect(await readRefusal(response(500, ""))).toEqual({ message: "Save failed (500)." });
  });
});
