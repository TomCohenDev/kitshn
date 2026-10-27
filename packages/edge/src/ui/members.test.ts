import { describe, expect, it } from "vitest";
import { memberFrom } from "./members.ts";

describe("the Add member input", () => {
  it("tells a person, a domain and a network apart from the text", () => {
    expect(memberFrom("auto", " Her@Example.com ")).toEqual({ _tag: "email", email: "her@example.com" });
    expect(memberFrom("auto", "@qlik.com")).toEqual({ _tag: "domain", domain: "qlik.com" });
    expect(memberFrom("auto", "qlik.com")).toEqual({ _tag: "domain", domain: "qlik.com" });
    expect(memberFrom("auto", "10.0.0.0/8")).toEqual({ _tag: "ip", range: "10.0.0.0/8" });
    expect(memberFrom("auto", "203.0.113.9")).toEqual({ _tag: "ip", range: "203.0.113.9/32" });
    expect(memberFrom("auto", "2001:db8::/32")).toEqual({ _tag: "ip", range: "2001:db8::/32" });
  });

  it("refuses what it cannot read, also when the kind is picked", () => {
    expect(memberFrom("auto", "her")).toBeTypeOf("string");
    expect(memberFrom("email", "qlik.com")).toBeTypeOf("string");
    expect(memberFrom("ip", "10.0.0.0/40")).toBeTypeOf("string");
    expect(memberFrom("auto", "")).toBeTypeOf("string");
  });

  it("adds everyone without text", () => {
    expect(memberFrom("everyone", "")).toEqual({ _tag: "everyone" });
  });
});
