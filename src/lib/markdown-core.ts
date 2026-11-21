/**
 * Description HTML <-> Markdown for agents (MCP get_task / create_task / update_task). Pure (no server-only imports)
 * so `markdown-core.test.mjs` runs it under plain `node --test`; `lib/mcp/context.ts` re-exports both.
 *
 * Text is escaped on the way out (VEC-243): characters that would read as Markdown markup (`[`, `]`, `` ` ``, `*`,
 * `~`, `<`, and a backslash before punctuation) get a backslash, so text someone typed, e.g. `![x](https://evil.example/t.png)`
 * in a public form, never looks like an image or link to an agent, and writing the Markdown back keeps it text.
 * `markdownToHtml` reads CommonMark backslash escapes back to the plain character.
 */

const NAMED: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/** HTML entities -> characters (named ones the sanitiser writes, plus numeric). */
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });

const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** ASCII punctuation, the characters a CommonMark backslash escape applies to. */
const PUNCT = "!\"#$%&'()*+,\\-./:;<=>?@[\\\\\\]^_`{|}~";

/**
 * Plain text -> Markdown that reads (and round-trips) as that same text. Only what could start markup is escaped,
 * so ordinary prose stays readable: `[ ] \` *` always, `~` in `~~`, `_` at a word edge (snake_case is left alone),
 * `<` before a tag-like character ("a < b" is left alone), a backslash only before punctuation.
 */
export function escapeMarkdownText(t: string): string {
  return t.replace(new RegExp(`\\\\(?=[${PUNCT}])|[\\[\\]\`*]|~(?=~)|(?<=~)~|(?<!\\w)_|_(?!\\w)|<(?=[A-Za-z/!?])`, "g"), (c) => `\\${c}`);
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}=\"([^\"]*)\"`, "i").exec(tag)?.[1] ?? "";
/** A URL that stays one Markdown link target: no spaces or parentheses. */
const mdUrl = (u: string) => u.replace(/[\s()]/g, (c) => encodeURIComponent(c));

/** Escape every text node outside <pre>/<code>; entities stay encoded (the final decode reverses it). */
function escapeTextNodes(html: string): string {
  let code = 0;
  return html.replace(/<[^>]*>|[^<]+/g, (part) => {
    if (part[0] === "<") {
      const m = /^<(\/?)(pre|code)\b/i.exec(part);
      if (m) code = Math.max(0, code + (m[1] ? -1 : 1));
      return part;
    }
    return code ? part : escHtml(escapeMarkdownText(decodeEntities(part)));
  });
}

/** Sanitised description HTML -> readable Markdown for agents. */
export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  let s = escapeTextNodes(html);
  s = s.replace(/<pre[^>]*>\s*<code([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, a: string, code: string) => {
    const lang = /language-([\w-]+)/.exec(a)?.[1] ?? "";
    // Re-encoded so the final decode leaves the code exactly as it was.
    return `\n\n\`\`\`${lang}\n${escHtml(decodeEntities(code.replace(/<[^>]+>/g, ""))).replace(/\n$/, "")}\n\`\`\`\n\n`;
  });
  s = s.replace(/<img\b[^>]*>/gi, (tag) => escHtml(`![${escapeMarkdownText(decodeEntities(attr(tag, "alt"))) || "image"}](${mdUrl(decodeEntities(attr(tag, "src")))})`));
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, a: string, text: string) => `[${text}](${escHtml(mdUrl(decodeEntities(attr(` ${a}`, "href"))))})`);
  s = s.replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t}\n\n`);
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**").replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*").replace(/<s>([\s\S]*?)<\/s>/gi, "~~$1~~");
  s = s.replace(/<u>([\s\S]*?)<\/u>/gi, "$1").replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner: string) => {
    let n = 0;
    return `\n\n${inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, t: string) => `${++n}. ${t.replace(/<\/?p>/gi, "").trim()}\n`)}\n`;
  });
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner: string) => `\n\n${inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, t: string) => `- ${t.replace(/<\/?p>/gi, "").trim()}\n`)}\n`);
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t: string) => {
    const inner = t.replace(/<\/p>\s*<p[^>]*>/gi, "\n").replace(/<\/?p[^>]*>/gi, "").trim();
    return `\n\n${inner.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
  });
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<p[^>]*>/gi, "");
  s = decodeEntities(s.replace(/<[^>]+>/g, ""));
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function inlineMd(t: string): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  // One left-to-right pass, as CommonMark reads it: a code span keeps its backslashes, an escape outside one becomes
  // the plain character (so an escaped backtick never opens a span), and neither is touched by the rules below.
  let s = t.replace(new RegExp(`\`([^\`]+)\`|\\\\([${PUNCT}])`, "g"), (_, c: string | undefined, e: string | undefined) =>
    hold(c !== undefined ? `<code>${escHtml(c)}</code>` : escHtml(e!)),
  );
  s = escHtml(s)
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/api\/uploads\/[^\s)]+)\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]);
}

/**
 * The text the HTML sniff looks at: Markdown with its fenced code blocks and inline code spans removed (read the way
 * markdownToHtml reads them: fences line by line, spans per line with backslash escapes first), so a tag written as code
 * (an anchor tag in backticks, say) doesn't make the whole Markdown pass through as HTML.
 */
function outsideCode(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^```\s*[\w-]*\s*$/.test(lines[i])) {
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) i++;
      continue;
    }
    kept.push(lines[i].replace(new RegExp(`\`[^\`]+\`|\\\\[${PUNCT}]`, "g"), (m) => (m[0] === "`" ? "" : m)));
  }
  return kept.join("\n");
}

/**
 * Agent-written Markdown (or plain text) -> description HTML. HTML input passes straight to the sanitiser; an escaped
 * `\<img ...>` is text, not HTML, and so is a tag inside a code span or fenced code block.
 */
export function markdownToHtml(src: string): string {
  if (/(?<!\\)<(p|h[1-3]|ul|ol|li|pre|img|a|strong|em|br|blockquote)\b[^>]*>/i.test(outsideCode(src))) return src;
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[1] ? ` class="language-${fence[1]}"` : ""}>${escHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && /\d/.test(/^\s*([-*+]|\d+[.)])/.exec(lines[i])![1]) === ordered) {
        items.push(`<li><p>${inlineMd(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""))}</p></li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote><p>${q.map(inlineMd).join("<br>")}</p></blockquote>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|>\s?|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(inlineMd).join("<br>")}</p>`);
  }
  return out.join("");
}
