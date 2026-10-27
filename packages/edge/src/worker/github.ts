import { SignJWT, importPKCS8 } from "jose";

/** The kitshn GitHub App (K-908): its id and its private key, in the PKCS #1 PEM that GitHub gives, or PKCS #8. */
export interface GitHubApp {
  readonly id: string;
  readonly key: string;
}

const derLength = (length: number) =>
  length < 0x80 ? [length] : length < 0x100 ? [0x81, length] : [0x82, length >> 8, length & 0xff];

/** Wraps a PKCS #1 RSA key in PKCS #8, so WebCrypto takes it; the bootstrap has no openssl (K-1203). */
export function pkcs8Pem(pem: string): string {
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return pem;
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const rsa = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  // version 0, then AlgorithmIdentifier rsaEncryption with NULL parameters.
  const head = [0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(rsa.length)];
  const inner = head.length + octet.length + rsa.length;
  const der = new Uint8Array([0x30, ...derLength(inner), ...head, ...octet, ...rsa]);
  const base64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END PRIVATE KEY-----`;
}

const API = "https://api.github.com";

/** A GitHub answer that is not 2xx, with its status, so a caller can tell a refusal from a fault. */
class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call(token: string, method: string, path: string, body?: object): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "kitshn",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    if (path.endsWith("/dispatches") && response.status === 422 && text.includes("workflow_dispatch"))
      throw new GitHubError(422, "Add workflow_dispatch to the repo's kitshn.yml.");
    throw new GitHubError(response.status, `GitHub answered ${response.status} for ${method} ${path}: ${text}`);
  }
  return response.status === 204 ? null : await response.json();
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("GitHub sent an answer that kitshn does not know.");
  return value as Record<string, unknown>;
};

/**
 * K-718, K-819: runs the repo's kitshn workflow on one branch through the App (`workflow_dispatch`). kitshn
 * names the repo by its id, never by a name that a rename or a new repo can take over: the token covers only
 * that repo id and only Actions, and the current name comes from that token. Returns the current full name.
 */
export async function dispatchDeploy(app: GitHubApp, repoId: string, branch: string, workflow: string) {
  const id = Number(repoId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${repoId} is not a GitHub repository id.`);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(app.id)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(await importPKCS8(pkcs8Pem(app.key), "RS256"));
  // GitHub looks up an installation only by a repo name, so kitshn asks each installation for a token of
  // this id. Only the first 100 installations count; the App has one per owner account (K-811).
  const installations = await call(jwt, "GET", "/app/installations?per_page=100");
  if (!Array.isArray(installations)) throw new Error("GitHub sent no list of installations.");
  let token: string | null = null;
  for (const installation of installations) {
    const installationId = record(installation)["id"];
    if (typeof installationId !== "number") throw new Error("GitHub sent an installation without an id.");
    if (record(installation)["suspended_at"]) continue;
    try {
      const access = record(
        await call(jwt, "POST", `/app/installations/${installationId}/access_tokens`, {
          repository_ids: [id],
          permissions: { actions: "write" },
        }),
      );
      if (typeof access["token"] !== "string") throw new Error("GitHub sent no installation token.");
      token = access["token"];
      break;
    } catch (error) {
      // This installation does not hold the repo, lacks Actions: write (422), or GitHub refuses it (403, 404).
      if (error instanceof GitHubError && [403, 404, 422].includes(error.status)) continue;
      throw error;
    }
  }
  if (token === null)
    throw new Error(
      "The kitshn GitHub App has no installation with this repo and the permission Actions: write. Install it on the repo and accept the permission.",
    );
  const repositories = record(await call(token, "GET", "/installation/repositories"))["repositories"];
  const repo = (Array.isArray(repositories) ? repositories : []).map(record).find((item) => item["id"] === id);
  const name = repo?.["full_name"];
  if (typeof name !== "string") throw new Error(`The installation token does not reach the repo ${repoId}.`);
  // A full branch ref, so a tag with the same name never runs.
  await call(token, "POST", `/repos/${name}/actions/workflows/${workflow}/dispatches`, {
    ref: `refs/heads/${branch}`,
  });
  return name;
}
