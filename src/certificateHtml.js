// src/certificateHtml.js
//
// Everything the rich-text editor's HTML goes through on the server:
//   sanitizeCertificateHtml  - allow-list sanitizer (no script, no event handlers,
//                              no remote images, limited inline CSS)
//   findUnresolvedBlanks     - highlighted blanks nobody has filled in yet
//   finalizeHtml             - replaces issuance tokens ({{CERT_NO}}, signature,
//                              seal...), unwraps filled blanks, re-sanitizes
//
// The editor is a browser contenteditable, so its output is untrusted input.

const sanitizeHtml = require("sanitize-html");
const { BY_KEY } = require("./certificateFields");

const MAX_HTML_BYTES = 600 * 1024;

const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/i];
const LEN = [/^-?\d+(\.\d+)?(px|pt|em|rem|%)?$/];
const PCT = [/^\d+(\.\d+)?%$/];
const SIZE = [/^(auto|\d+(\.\d+)?(px|pt|em|rem|%|mm|cm)?)$/];
// shorthand like "1px solid #000000" / "4px 8px"; never anything that can load a resource
const SAFE_SHORT = [/^(?!.*url)[#\w\s().,%-]+$/i];

const SANITIZE_OPTIONS = {
  allowedTags: [
    "p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "mark", "code",
    "h1", "h2", "h3", "h4", "blockquote", "hr", "ul", "ol", "li", "font",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col", "caption", "img"
  ],
  allowedAttributes: {
    "*": ["style", "class", "data-field", "data-ph", "data-token", "title", "align"],
    table: ["border", "cellpadding", "cellspacing", "width", "style", "class", "align"],
    td: ["colspan", "rowspan", "style", "class", "width", "height", "align", "valign"],
    th: ["colspan", "rowspan", "style", "class", "width", "height", "align", "valign"],
    col: ["span", "width", "style"],
    font: ["size", "color", "face"],
    img: ["src", "alt", "style", "class", "width", "height"]
  },
  allowedClasses: {
    "*": ["cert-heading", "sig-marks", "sig-name", "sig-title", "verify-footer", "cert-type-footer", "blank", "adept-table", "sig-token"]
  },
  allowedStyles: {
    "*": {
      "text-align": [/^(left|right|center|justify)$/],
      "font-size": LEN,
      "font-family": [/^[\w\s,"'.-]+$/],
      "font-weight": [/^(normal|bold|[1-9]00)$/],
      "font-style": [/^(normal|italic)$/],
      "text-decoration": [/^(none|underline|line-through|underline line-through|line-through underline)$/],
      "color": COLOR,
      "background-color": COLOR,
      "line-height": LEN,
      "margin-left": LEN, "margin-top": LEN, "margin-bottom": LEN,
      "padding-left": LEN,
      "text-indent": LEN,
      "position": [/^(absolute|relative)$/],
      "top": PCT, "left": PCT,
      "max-width": LEN, "max-height": LEN, "min-height": LEN,
      "width": SIZE, "height": SIZE,
      "border": SAFE_SHORT, "border-top": SAFE_SHORT, "border-right": SAFE_SHORT, "border-bottom": SAFE_SHORT, "border-left": SAFE_SHORT,
      "border-collapse": [/^(collapse|separate)$/], "border-spacing": SAFE_SHORT,
      "border-color": SAFE_SHORT, "border-style": SAFE_SHORT, "border-width": SAFE_SHORT,
      "padding": SAFE_SHORT, "padding-top": LEN, "padding-right": LEN, "padding-bottom": LEN,
      "margin": SAFE_SHORT, "margin-right": LEN,
      "vertical-align": [/^(top|middle|bottom|baseline)$/],
      "float": [/^(left|right|none)$/], "display": [/^(block|inline|inline-block)$/]
    }
  },
  allowedSchemes: [],
  allowedSchemesByTag: { img: ["data"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // Only inline raster images; never remote URLs, never SVG.
  exclusiveFilter: function (frame) {
    if (frame.tag === "img") {
      const src = (frame.attribs && frame.attribs.src) || "";
      return !/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src);
    }
    return false;
  }
};

function sanitizeCertificateHtml(html) {
  const s = String(html == null ? "" : html);
  if (Buffer.byteLength(s, "utf8") > MAX_HTML_BYTES) {
    const e = new Error("Certificate content is too large.");
    e.code = "TOO_LARGE";
    throw e;
  }
  return sanitizeHtml(s, SANITIZE_OPTIONS);
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
function attr(tag, name) {
  const m = tag.match(new RegExp("\\s" + name + '="([^"]*)"'));
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&") : null;
}

const BLANK_RE = /<mark\b([^>]*\sclass="[^"]*\bblank\b[^"]*"[^>]*)>([\s\S]*?)<\/mark>/g;

// A blank is "unresolved" only while its text still equals the placeholder it
// was rendered with. Typing over it (or pasting a value in) resolves it.
function findUnresolvedBlanks(html) {
  const out = [];
  let m;
  const re = new RegExp(BLANK_RE.source, "g");
  while ((m = re.exec(html))) {
    const ph = attr(" " + m[1], "data-ph");
    const field = attr(" " + m[1], "data-field");
    const text = stripTags(m[2]);
    if (text === "" || (ph !== null && stripTags(ph) === text)) {
      const def = field && BY_KEY[field];
      out.push({ field: field || "unknown", label: def ? def.label : (ph || "blank"), placeholder: ph || text });
    }
  }
  return out;
}

function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }

// Unwrap every highlighted blank into plain text (filled ones keep their text).
function unwrapBlanks(html) {
  return html.replace(new RegExp(BLANK_RE.source, "g"), function (_all, _attrs, inner) { return inner; });
}

function tokenImg(data, pos, defTop, defLeft, maxW, maxH, alt) {
  const p = pos || {};
  const top = Number(p.top);
  const left = Number(p.left);
  return '<img src="' + escapeAttr(data) + '" style="position:absolute;top:' + (isFinite(top) ? top : defTop) + "%;left:" +
    (isFinite(left) ? left : defLeft) + "%;max-width:" + maxW + "px;max-height:" + maxH + 'px;" alt="' + alt + '">';
}

// Replace a token span, tolerating the editor having wrapped it in formatting.
function replaceTokenSpan(html, token, replacement) {
  const re = new RegExp('<span\\b[^>]*data-token="' + token + '"[^>]*>[\\s\\S]*?</span>', "g");
  if (!re.test(html)) return { html, found: false };
  return { html: html.replace(new RegExp(re.source, "g"), replacement), found: true };
}

/**
 * Turn the editor's working HTML into the final, frozen certificate body.
 * opts: { certNo, issuedAt, qrToken, signatureData, sealData, signaturePosition, sealPosition }
 */
function finalizeHtml(rawHtml, opts) {
  let html = sanitizeCertificateHtml(rawHtml);
  const dateStr = new Date(opts.issuedAt || Date.now()).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  html = html.split("{{CERT_NO}}").join(opts.certNo).split("{{ISSUE_DATE}}").join(dateStr).split("{{QR_TOKEN}}").join(opts.qrToken);

  const sig = opts.signatureData ? tokenImg(opts.signatureData, opts.signaturePosition, 78, 8, 150, 60, "Registrar signature") : "";
  const seal = opts.sealData ? tokenImg(opts.sealData, opts.sealPosition, 70, 60, 110, 110, "Official seal") : "";

  const rs = replaceTokenSpan(html, "signature", sig);
  html = rs.html;
  const rk = replaceTokenSpan(html, "seal", seal);
  html = rk.html;

  // If someone deleted the signature placeholder in the editor, still put the
  // signature on the certificate: a certificate without one must never go out.
  if (!rs.found && sig) {
    html = html.replace(/(<p class="sig-name">)/, '<div class="sig-marks" style="position:relative;min-height:70px;">' + sig + (rk.found || !seal ? "" : "&nbsp;&nbsp;&nbsp;" + seal) + "</div>$1");
    if (!/<div class="sig-marks"/.test(html)) html += '<div class="sig-marks" style="position:relative;min-height:70px;">' + sig + seal + "</div>";
  }

  html = unwrapBlanks(html);
  return sanitizeCertificateHtml(html);
}

module.exports = { sanitizeCertificateHtml, findUnresolvedBlanks, finalizeHtml, unwrapBlanks, MAX_HTML_BYTES };
