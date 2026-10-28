/** The content type of a file by its extension, for deploys (K-805) and the preview arrow (K-520). */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".gpx": "application/gpx+xml",
  ".webmanifest": "application/manifest+json",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export function contentType(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return (dot >= 0 ? TYPES[fileName.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream";
}

/** K-520: a type that a browser shows in a frame instead of downloading it: images, PDF, text, audio, video. */
export const showsInline = (type: string) =>
  ["image/", "text/", "audio/", "video/", "application/pdf"].some((prefix) => type.startsWith(prefix));
