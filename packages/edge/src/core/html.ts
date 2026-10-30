/** Text for HTML that kitshn writes itself: element content and double-quoted attributes. */
export const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
