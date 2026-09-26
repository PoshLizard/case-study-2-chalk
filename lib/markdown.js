// Small markdown helper for club posts.
// Supports the handful of bits people actually type on a wall.
//
// Post bodies are user input and get rendered with dangerouslySetInnerHTML,
// so we HTML-escape the raw text FIRST and only then splice in our own trusted
// tags. That neutralizes any markup a member types (e.g. <img onerror=...>)
// while leaving **bold**, *italic*, `code`, headings, lists, and [links] intact.

function escapeHtml(src) {
  return String(src ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only allow links we're comfortable putting behind an <a href>. Absolute
// http(s)/mailto links and site-relative links pass; javascript:, data:, and
// other schemes are rejected so a link can't smuggle script back in.
function safeUrl(url) {
  const trimmed = String(url || "").trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^(\/|#|\.\/|\.\.\/)/.test(trimmed)) return trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed; // no scheme => relative
  return null;
}

function renderMarkdown(src) {
  return escapeHtml(src)
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, url) => {
      const href = safeUrl(url);
      return href ? `<a href="${href}">${label}</a>` : label;
    })
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>")
    .replace(/\n/g, "<br>");
}

module.exports = { renderMarkdown };
