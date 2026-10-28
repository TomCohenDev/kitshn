import { describe, expect, it } from "vitest";
import { readAnswer, readRequest } from "./index.ts";

describe("local socket framing (K-702)", () => {
  it("reads a request with its id", () => {
    expect(readRequest('{"id":"a","type":"status"}')).toEqual({
      ok: true,
      request: { id: "a", type: "status" },
    });
  });

  it("turns a bad line into an error answer, with the id when the line has a valid one", () => {
    expect(readRequest("{")).toMatchObject({ ok: false, answer: { id: null, type: "error" } });
    expect(readRequest('{"id":"a","type":"pass"}')).toMatchObject({
      ok: false,
      answer: { id: "a", type: "error" },
    });
    expect(readRequest('{"id":"","type":"status"}')).toMatchObject({ ok: false, answer: { id: null } });
    expect(readRequest('{"type":"status"}')).toMatchObject({ ok: false, answer: { id: null } });
  });

  it("throws on an answer that does not match, since daemon and client then disagree", () => {
    expect(() => readAnswer('{"id":"a","type":"status"}')).toThrow();
    expect(readAnswer('{"id":"a","type":"reconnect"}')).toEqual({ id: "a", type: "reconnect" });
  });
});
