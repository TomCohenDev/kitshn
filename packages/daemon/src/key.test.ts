import { parsePrivateKey, signText, verifyText } from "@kitshn/edge/machine";
import { describe, expect, it } from "vitest";

const base64url = (hex: string) => Buffer.from(hex, "hex").toString("base64url");

// RFC 8032, section 7.1, test 1: Ed25519 is deterministic, so Bun must give exactly this signature.
const vector = {
  d: base64url("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
  x: base64url("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
  signature: base64url(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  ),
};

describe("machine key in the Bun daemon (K-1701)", () => {
  it("signs as the Ed25519 standard says, so the Worker verifies it", async () => {
    const key = parsePrivateKey({ kty: "OKP", crv: "Ed25519", x: vector.x, d: vector.d });
    if (!key) throw new Error("the test vector is not a key");
    expect(await signText(key, "")).toBe(vector.signature);
    expect(await verifyText(vector.x, "", vector.signature)).toBe(true);
  });
});
