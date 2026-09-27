// src/brand-extraction/extract.ts
var DEFAULT_TIMEOUT_MS = 15e3;
var DEFAULT_MAX_PER_LIST = 12;
function normalizeSiteUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}
function absolutize(href, base) {
  const v = href.trim();
  if (!v || v.startsWith("data:") || v.startsWith("javascript:")) return null;
  try {
    const u = new URL(v, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}
function matchTags(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  return html.match(re) ?? [];
}
function attr(tag, name) {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  if (quoted) return decodeEntities(quoted[1] ?? "");
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s"'>]+)`, "i").exec(tag);
  return bare ? decodeEntities(bare[1] ?? "") : void 0;
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/gi, "/");
}
function extractName(html) {
  for (const tag of matchTags(html, "meta")) {
    const prop = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    if (prop === "og:site_name") {
      const c = attr(tag, "content")?.trim();
      if (c) return c;
    }
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title) {
    const head = (decodeEntities(title).split(/\s+[|–—\-:·]\s+/)[0] ?? "").trim();
    if (head) return head;
  }
  return void 0;
}
function extractDescription(html) {
  for (const tag of matchTags(html, "meta")) {
    const prop = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    if (prop === "description" || prop === "og:description") {
      const c = attr(tag, "content")?.trim();
      if (c) return c;
    }
  }
  return void 0;
}
var MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon"
};
function mimeFromUrl(url) {
  const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
  return ext ? MIME_BY_EXT[ext] : void 0;
}
function parseSizes(sizes) {
  if (!sizes) return {};
  const m = /(\d+)\s*[x×]\s*(\d+)/i.exec(sizes);
  if (!m) return {};
  return { width: Number(m[1]), height: Number(m[2]) };
}
function extractLogos(html, base) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (c) => {
    if (seen.has(c.url)) return;
    seen.add(c.url);
    out.push(c);
  };
  for (const tag of matchTags(html, "link")) {
    const rel = attr(tag, "rel")?.toLowerCase() ?? "";
    const href = attr(tag, "href");
    if (!href) continue;
    const url = absolutize(href, base);
    if (!url) continue;
    const { width, height } = parseSizes(attr(tag, "sizes"));
    if (rel.includes("apple-touch-icon")) {
      push({ url, source: "apple-touch-icon", confidence: 0.7, width, height, mimeType: mimeFromUrl(url) });
    } else if (rel.split(/\s+/).includes("icon") || rel.includes("shortcut icon")) {
      push({ url, source: "favicon", confidence: 0.5, width, height, mimeType: mimeFromUrl(url) });
    }
  }
  for (const tag of matchTags(html, "meta")) {
    const prop = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    if (prop === "og:image" || prop === "og:image:url") {
      const href = attr(tag, "content");
      const url = href ? absolutize(href, base) : null;
      if (url) push({ url, source: "og:image", confidence: 0.55, mimeType: mimeFromUrl(url) });
    }
  }
  for (const tag of matchTags(html, "img")) {
    const src = attr(tag, "src") ?? attr(tag, "data-src");
    if (!src) continue;
    const alt = attr(tag, "alt");
    const cls = attr(tag, "class") ?? "";
    const id = attr(tag, "id") ?? "";
    const looksLikeLogo = /logo|brand|wordmark/i.test(`${src} ${alt ?? ""} ${cls} ${id}`);
    if (!looksLikeLogo) continue;
    const url = absolutize(src, base);
    if (!url) continue;
    const w = attr(tag, "width");
    const h = attr(tag, "height");
    push({
      url,
      source: "img-logo",
      confidence: 0.85,
      alt,
      width: w ? Number(w) || void 0 : void 0,
      height: h ? Number(h) || void 0 : void 0,
      mimeType: mimeFromUrl(url)
    });
  }
  if (!out.some((l) => l.source === "favicon" || l.source === "apple-touch-icon")) {
    const fav = absolutize("/favicon.ico", base);
    if (fav) push({ url: fav, source: "favicon", confidence: 0.3, mimeType: "image/x-icon" });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
function normalizeColor(raw) {
  const v = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (hex) {
    const h = hex[1] ?? "";
    if (h.length === 3 || h.length === 4) {
      return `#${h.split("").map((c) => c + c).join("")}`;
    }
    return `#${h}`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/.exec(v);
  if (rgb) {
    const to255 = (n) => Math.max(0, Math.min(255, Math.round(Number(n))));
    const r = to255(rgb[1]).toString(16).padStart(2, "0");
    const g = to255(rgb[2]).toString(16).padStart(2, "0");
    const b = to255(rgb[3]).toString(16).padStart(2, "0");
    let a = "";
    if (rgb[4] !== void 0) {
      const av = rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
      const ai = Math.max(0, Math.min(255, Math.round(av * 255)));
      if (ai < 255) a = ai.toString(16).padStart(2, "0");
    }
    return `#${r}${g}${b}${a}`;
  }
  return null;
}
var COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
var ROOT_VAR_RE = /(--[a-z0-9-]*(?:color|colour|bg|background|accent|brand|primary|secondary|surface|text|fg|ink)[a-z0-9-]*)\s*:\s*([^;}{]+)/gi;
function extractPalette(html) {
  const byHex = /* @__PURE__ */ new Map();
  const bump = (hex, fromToken, tokenName) => {
    const existing = byHex.get(hex);
    if (existing) {
      existing.occurrences += 1;
      if (fromToken && !existing.fromToken) {
        existing.fromToken = true;
        existing.tokenName = tokenName;
      }
    } else {
      byHex.set(hex, { hex, occurrences: 1, fromToken, ...tokenName ? { tokenName } : {} });
    }
  };
  for (const m of html.matchAll(ROOT_VAR_RE)) {
    const tokenName = m[1];
    const value = m[2];
    if (!value) continue;
    const lit = value.match(COLOR_LITERAL_RE)?.[0];
    if (!lit) continue;
    const hex = normalizeColor(lit);
    if (hex) bump(hex, true, tokenName);
  }
  for (const m of html.matchAll(COLOR_LITERAL_RE)) {
    const hex = normalizeColor(m[0]);
    if (hex) bump(hex, false);
  }
  const isNeutral = (h) => /^#(0{6}|f{6})(ff)?$/i.test(h);
  return [...byHex.values()].sort((a, b) => {
    if (a.fromToken !== b.fromToken) return a.fromToken ? -1 : 1;
    const an = isNeutral(a.hex) ? 1 : 0;
    const bn = isNeutral(b.hex) ? 1 : 0;
    if (an !== bn) return an - bn;
    return b.occurrences - a.occurrences;
  });
}
var GENERIC_FAMILIES = /* @__PURE__ */ new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "inherit",
  "initial",
  "unset"
]);
var FONT_DECL_RE = /([^{}]*)\{[^{}]*font-family\s*:\s*([^;}{]+)[;}]/gi;
function parseFontStack(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}
function roleFromSelector(selector) {
  const s = selector.toLowerCase();
  if (/\b(h[1-3]|\.h[1-3]|heading|title|display|hero)\b/.test(s)) return "display";
  if (/\b(body|p|html|\.text|\.content|root|:root|\*)\b/.test(s)) return "body";
  return "unknown";
}
function extractFonts(html) {
  const byFamily = /* @__PURE__ */ new Map();
  const consider = (family, stack, role) => {
    const key = family.toLowerCase();
    if (!family || GENERIC_FAMILIES.has(key)) return;
    const existing = byFamily.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (existing.role === "unknown" && role !== "unknown") existing.role = role;
    } else {
      byFamily.set(key, { family, stack, role, occurrences: 1 });
    }
  };
  for (const m of html.matchAll(FONT_DECL_RE)) {
    const selector = m[1] ?? "";
    const stack = parseFontStack(m[2]);
    const primary = stack[0];
    if (!primary) continue;
    consider(primary, stack, roleFromSelector(selector));
  }
  const BARE_RE = /font-family\s*:\s*([^;"'}{]+)/gi;
  for (const m of html.matchAll(BARE_RE)) {
    const stack = parseFontStack(m[1]);
    const primary = stack[0];
    if (!primary) continue;
    consider(primary, stack, "unknown");
  }
  for (const tag of matchTags(html, "link")) {
    const href = attr(tag, "href") ?? "";
    if (!/fonts\.googleapis\.com/i.test(href)) continue;
    for (const fam of href.matchAll(/family=([^:&]+)/gi)) {
      const captured = fam[1];
      if (!captured) continue;
      const family = decodeURIComponent(captured.replace(/\+/g, " ")).trim();
      consider(family, [family], "display");
    }
  }
  return [...byFamily.values()].sort((a, b) => {
    const rank = (r) => r === "display" ? 0 : r === "body" ? 1 : 2;
    const rr = rank(a.role) - rank(b.role);
    if (rr !== 0) return rr;
    return b.occurrences - a.occurrences;
  });
}
function extractImages(html, base) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (img) => {
    if (seen.has(img.url)) return;
    seen.add(img.url);
    out.push(img);
  };
  for (const tag of matchTags(html, "meta")) {
    const prop = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
    const href = attr(tag, "content");
    const url = href ? absolutize(href, base) : null;
    if (!url) continue;
    if (prop === "og:image" || prop === "og:image:url") push({ url, source: "og:image" });
    else if (prop === "twitter:image" || prop === "twitter:image:src") push({ url, source: "twitter:image" });
  }
  for (const tag of matchTags(html, "img")) {
    const src = attr(tag, "src") ?? attr(tag, "data-src");
    if (!src) continue;
    const url = absolutize(src, base);
    if (!url) continue;
    const cls = `${attr(tag, "class") ?? ""} ${attr(tag, "id") ?? ""}`;
    if (/logo|icon|favicon|wordmark/i.test(`${url} ${cls}`)) continue;
    const isHero = /hero|banner|cover|feature|splash/i.test(cls);
    const w = attr(tag, "width");
    const h = attr(tag, "height");
    push({
      url,
      source: isHero ? "img-hero" : "img-content",
      alt: attr(tag, "alt"),
      width: w ? Number(w) || void 0 : void 0,
      height: h ? Number(h) || void 0 : void 0
    });
  }
  const rank = (s) => s === "og:image" ? 0 : s === "twitter:image" ? 1 : s === "img-hero" ? 2 : 3;
  return out.sort((a, b) => rank(a.source) - rank(b.source));
}
function parseBrandKit(html, sourceUrl, maxPerList = DEFAULT_MAX_PER_LIST) {
  const logos = extractLogos(html, sourceUrl).slice(0, maxPerList);
  const palette = extractPalette(html).slice(0, maxPerList);
  const fonts = extractFonts(html).slice(0, maxPerList);
  const images = extractImages(html, sourceUrl).slice(0, maxPerList);
  const name = extractName(html);
  const description = extractDescription(html);
  return {
    sourceUrl,
    ...name ? { name } : {},
    ...description ? { description } : {},
    logos,
    palette,
    fonts,
    images,
    extractedFrom: [sourceUrl]
  };
}
async function extractBrandKit(url, options = {}) {
  const { html: providedHtml, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, maxPerList = DEFAULT_MAX_PER_LIST } = options;
  const warnings = [];
  const sourceUrl = normalizeSiteUrl(url);
  if (!sourceUrl) {
    return { succeeded: false, error: `Not a valid http(s) URL: ${JSON.stringify(url)}`, stage: "input" };
  }
  let html = providedHtml;
  if (html === void 0) {
    const doFetch = fetchImpl ?? (typeof globalThis.fetch === "function" ? (u, init) => globalThis.fetch(u, init) : void 0);
    if (!doFetch) {
      return { succeeded: false, error: "No html provided and no fetch implementation available", stage: "input" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(sourceUrl, {
        signal: controller.signal,
        headers: { "user-agent": "TangleBrandExtractor/1.0 (+https://tangle.tools)" }
      });
      if (!res.ok) {
        return { succeeded: false, error: `Fetch failed: HTTP ${res.status} for ${sourceUrl}`, stage: "fetch" };
      }
      html = await res.text();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { succeeded: false, error: `Fetch error for ${sourceUrl}: ${reason}`, stage: "fetch" };
    } finally {
      clearTimeout(timer);
    }
  }
  if (!html.trim()) {
    return { succeeded: false, error: `Empty document for ${sourceUrl}`, stage: "parse" };
  }
  const kit = parseBrandKit(html, sourceUrl, maxPerList);
  if (kit.logos.length === 0) warnings.push("No logo candidates found.");
  if (kit.palette.length === 0) warnings.push("No colors extracted \u2014 page has no inline CSS or design tokens.");
  if (kit.fonts.length === 0) warnings.push("No custom fonts found \u2014 site likely uses system defaults.");
  if (kit.images.length === 0) warnings.push("No prominent images found.");
  return { succeeded: true, kit, warnings };
}

// src/brand-extraction/map.ts
function luminance(hex) {
  const h = hex.replace("#", "").slice(0, 6);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function isGreyish(hex) {
  const h = hex.replace("#", "").slice(0, 6);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min < 18;
}
function decidePalette(palette) {
  if (palette.length === 0) return {};
  const hexes = palette.map((c) => c.hex);
  const greys = hexes.filter(isGreyish).sort((a, b) => luminance(b) - luminance(a));
  const colored = hexes.filter((h) => !isGreyish(h));
  const accent = colored[0];
  const sortedLight = [...hexes].sort((a, b) => luminance(b) - luminance(a));
  const background = greys[0] ?? sortedLight[0];
  const surface = greys[1] ?? sortedLight.find((h) => h !== background);
  const textPrimary = [...hexes].sort((a, b) => luminance(a) - luminance(b))[0];
  const textSecondary = greys.find((h) => h !== background && h !== surface && h !== textPrimary);
  const result = {};
  if (background) result.background = background;
  if (surface) result.surface = surface;
  if (textPrimary) result.textPrimary = textPrimary;
  if (textSecondary) result.textSecondary = textSecondary;
  if (accent) {
    result.accent = accent;
    result.accentText = luminance(accent) > 0.45 ? "#000000" : "#ffffff";
  }
  return result;
}
function decideFonts(fonts) {
  if (fonts.length === 0) return {};
  const display = fonts.find((f) => f.role === "display") ?? fonts[0];
  const body = fonts.find((f) => f.role === "body") ?? fonts.find((f) => f !== display) ?? display;
  return { display, body };
}
function decideBrandKit(kit) {
  const palette = decidePalette(kit.palette);
  const fonts = decideFonts(kit.fonts);
  const logoUrls = kit.logos.map((l) => l.url);
  const result = {
    sourceUrl: kit.sourceUrl,
    palette,
    fonts,
    logoUrls,
    imageUrls: kit.images.map((i) => i.url),
    extractedFrom: kit.extractedFrom
  };
  if (kit.name) result.name = kit.name;
  if (kit.description) result.description = kit.description;
  if (logoUrls[0]) result.primaryLogoUrl = logoUrls[0];
  return result;
}
export {
  decideBrandKit,
  decideFonts,
  decidePalette,
  extractBrandKit,
  luminance,
  normalizeColor,
  normalizeSiteUrl,
  parseBrandKit
};
//# sourceMappingURL=index.js.map