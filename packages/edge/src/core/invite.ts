/** K-720: the slot of a client's `open` link that takes the invite link. */
export const INVITE_URL_SLOT = "{inviteUrl}";

/** K-720: a client's `open` link for one invite; the invite link is URL-encoded, so its `#` becomes `%23`. */
export const openLink = (template: string, inviteUrl: string) =>
  template.replaceAll(INVITE_URL_SLOT, encodeURIComponent(inviteUrl));
