const MINUTE = 60_000;

/** "5 min ago", "in 3 h": how far a time is from now, in the largest unit that reads well. */
function distance(at: number, now: number): string {
  const minutes = Math.round(Math.abs(at - now) / MINUTE);
  if (minutes < 1) return "now";
  const amount =
    minutes < 60
      ? `${minutes} min`
      : minutes < 48 * 60
        ? `${Math.round(minutes / 60)} h`
        : `${Math.round(minutes / 1440)} d`;
  return at < now ? `${amount} ago` : `in ${amount}`;
}

/**
 * A time for people: "5 min ago · 3:11 PM" today, "in 2 d · Nov 1, 9:00 AM" on another day, in the browser's locale,
 * with no seconds. After "until" use `untilText`, which has no "in". Logs keep their own exact times.
 */
export function whenText(at: number, now = Date.now()): string {
  const date = new Date(at);
  const clock = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day =
    date.toDateString() === new Date(now).toDateString()
      ? clock
      : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock}`;
  return `${distance(at, now)} · ${day}`;
}
