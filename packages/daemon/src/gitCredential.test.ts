import { describe, expect, it } from "vitest";
import {
  answersMarkedPush,
  credentialAnswer,
  credentialReply,
  permissionOfCredential,
  readCredentialInput,
  repoOfCredential,
  repoOfRemote,
} from "./gitCredential.ts";

describe("git credential helper (K-1763, K-1764)", () => {
  it("takes the repo only from a github.com https request with a path", () => {
    const input = readCredentialInput("protocol=https\nhost=github.com\npath=Yarden-zamir/riffle.git\n\n");
    expect(repoOfCredential(input)).toBe("Yarden-zamir/riffle");
    expect(repoOfCredential(readCredentialInput("protocol=https\nhost=github.com\n\n"))).toBeNull();
    expect(repoOfCredential(readCredentialInput("protocol=https\nhost=gitlab.com\npath=a/b\n\n"))).toBeNull();
  });

  it("reads a remote of github.com over https or ssh", () => {
    expect(repoOfRemote("https://github.com/Yarden-zamir/kitshn.git")).toBe("Yarden-zamir/kitshn");
    expect(repoOfRemote("git@github.com:Yarden-zamir/kitshn.git")).toBe("Yarden-zamir/kitshn");
    expect(repoOfRemote("https://example.com/a/b")).toBeNull();
  });

  it("answers with the expiry, so a helper that stores the token drops it", () => {
    expect(credentialAnswer("t", "2026-10-29T10:00:00Z")).toBe(
      "username=x-access-token\npassword=t\npassword_expiry_utc=1793268000\n",
    );
  });

  it("stops git with quit=1 only when kitshn refuses or waits; a daemon that cannot help leaves git to its next helper", () => {
    expect(credentialReply({ id: "1", type: "error", error: "the daemon has no signed connection" })).toEqual(
      {
        stdout: "",
        stderr: null,
      },
    );
    expect(credentialReply(null)).toEqual({ stdout: "", stderr: null });
    expect(credentialReply({ id: "1", type: "ask", outcome: "not-kitshn", reason: "x" })).toEqual({
      stdout: "",
      stderr: null,
    });
    expect(
      credentialReply({
        id: "1",
        type: "ask",
        outcome: "refused",
        reason: "could not check the T3 thread; try again.",
      }),
    ).toEqual({ stdout: "quit=1\n", stderr: "kitshn: could not check the T3 thread; try again." });
  });

  it("asks for write only on a push, which kitshn setup-git marks with the user kitshn-push", () => {
    const push = readCredentialInput(
      "protocol=https\nhost=github.com\nusername=kitshn-push\npath=a/b.git\n\n",
    );
    expect(permissionOfCredential(push)).toBe("write");
    expect(
      permissionOfCredential(readCredentialInput("protocol=https\nhost=github.com\npath=a/b.git\n\n")),
    ).toBe("read");
  });

  it("clears the push mark when kitshn cannot help, so the next helper (gh) answers for its own user", () => {
    const notKitshn = { id: "1", type: "ask", outcome: "not-kitshn", reason: "x" } as const;
    expect(credentialReply(notKitshn, true)).toEqual({ stdout: "username=\n", stderr: null });
    expect(credentialReply(null, true)).toEqual({ stdout: "username=\n", stderr: null });
    expect(credentialReply(notKitshn, false)).toEqual({ stdout: "", stderr: null });
    // setup-git warns about every later helper that looks up the user name.
    expect(answersMarkedPush("!/opt/homebrew/bin/gh auth git-credential")).toBe(true);
    expect(
      ["osxkeychain", "store", "cache", "/usr/lib/git-core/git-credential-libsecret"].some(answersMarkedPush),
    ).toBe(false);
  });
});
