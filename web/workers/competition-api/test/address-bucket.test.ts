import { describe, expect, test } from "vitest";
import { addressBucket } from "../src/rate-limit";

describe("addressBucket", () => {
  test("an IPv4 address is its own bucket", () => {
    expect(addressBucket("203.0.113.9")).toBe("203.0.113.9");
  });

  test("every address in one IPv6 /64 shares a bucket", () => {
    const a = addressBucket("2001:db8:1:2::1");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(a);
    expect(addressBucket("2001:db8:1:2:aaaa::7")).toBe(a);
  });

  test("different /64s are different buckets", () => {
    expect(addressBucket("2001:db8:1:3::1")).not.toBe(addressBucket("2001:db8:1:2::1"));
  });

  test("compressed zeros before the /64 boundary expand correctly", () => {
    expect(addressBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressBucket("::1")).toBe("0:0:0:0::/64");
  });

  test("an IPv4-mapped IPv6 address counts as its IPv4 address", () => {
    expect(addressBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  test("anything malformed is returned unchanged", () => {
    expect(addressBucket("unknown")).toBe("unknown");
    expect(addressBucket("1::2::3")).toBe("1::2::3");
    expect(addressBucket("zzzz::1")).toBe("zzzz::1");
  });
});
