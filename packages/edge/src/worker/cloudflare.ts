export class CloudflareError extends Error {
  override readonly name = "CloudflareError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  readonly success: boolean;
  readonly result: T;
  readonly errors?: ReadonlyArray<{ readonly code: number; readonly message: string }>;
}

/** One Cloudflare API call. Each call is one subrequest (K-406). */
export async function cloudflare<T>(
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let envelope: Envelope<T> | null = null;
  try {
    envelope = JSON.parse(text) as Envelope<T>;
  } catch {
    // Not JSON: report the status and the start of the text.
  }
  if (!response.ok || !envelope?.success) {
    const reason = envelope?.errors?.map((error) => `${error.code}: ${error.message}`).join("; ");
    throw new CloudflareError(response.status, `${method} ${path} failed (${response.status}): ${reason ?? text.slice(0, 200)}`);
  }
  return envelope.result;
}
