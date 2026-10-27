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

async function call(token: string, method: string, path: string, body?: object) {
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
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${method} ${path}: ${await response.text()}`);
  return response.status === 204 ? null : ((await response.json()) as Record<string, unknown>);
}

/**
 * K-718: runs the repo's kitshn workflow on one branch through the App (`workflow_dispatch`). The token
 * covers only that repo and only Actions, so it can start the repo's own code and nothing else.
 */
export async function dispatchDeploy(app: GitHubApp, repo: string, branch: string, workflow: string) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(app.id)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(await importPKCS8(pkcs8Pem(app.key), "RS256"));
  const installation = await call(jwt, "GET", `/repos/${repo}/installation`);
  const name = repo.split("/")[1] ?? repo;
  const access = await call(jwt, "POST", `/app/installations/${String(installation?.["id"])}/access_tokens`, {
    repositories: [name],
    permissions: { actions: "write" },
  });
  await call(String(access?.["token"]), "POST", `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    ref: branch,
  });
}
