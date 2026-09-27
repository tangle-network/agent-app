// src/skills/index.ts
function inlineResource(name, content) {
  return { kind: "inline", name, content };
}
function skillMountPath(id) {
  return `~/.claude/skills/${id}/SKILL.md`;
}
function normalizeKey(key, anchor) {
  const marker = `${anchor}/`;
  const at = key.lastIndexOf(marker);
  if (at >= 0) return key.slice(at);
  return key.startsWith("./") ? key.slice(2) : key;
}
function toCorpusId(normalizedKey, anchor) {
  const nested = normalizedKey.match(new RegExp(`${anchor}/([^/]+)/SKILL\\.md$`));
  if (nested) return nested[1];
  const flat = normalizedKey.match(new RegExp(`${anchor}/(.+)\\.md$`));
  if (flat) return flat[1];
  return normalizedKey;
}
function nodeBuiltins() {
  const getBuiltin = globalThis.process?.getBuiltinModule;
  if (typeof getBuiltin !== "function") return void 0;
  return {
    fs: getBuiltin("node:fs"),
    path: getBuiltin("node:path"),
    url: getBuiltin("node:url")
  };
}
function fsWalkFlat(builtins, root) {
  const { fs, path } = builtins;
  const out = {};
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) out[full] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}
function fsWalkNested(builtins, root) {
  const { fs, path } = builtins;
  const out = {};
  if (!fs.existsSync(root)) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    out[skillFile] = fs.readFileSync(skillFile, "utf8");
  }
  return out;
}
function resolveFsBase(builtins, fsBaseDir, importMetaUrl) {
  const { path, url } = builtins;
  if (path.isAbsolute(fsBaseDir)) return fsBaseDir;
  const here = importMetaUrl ? path.dirname(url.fileURLToPath(importMetaUrl)) : process.cwd();
  return path.join(here, fsBaseDir);
}
function loadMarkdownCorpus(options, importMetaUrl) {
  const { anchor, globModules, fsBaseDir, fsLayout = "flat", skip } = options;
  let modules;
  let source;
  if (globModules && Object.keys(globModules).length > 0) {
    modules = globModules;
    source = "vite";
  } else {
    const builtins = nodeBuiltins();
    if (builtins && fsBaseDir) {
      const root = resolveFsBase(builtins, fsBaseDir, importMetaUrl);
      modules = fsLayout === "nested" ? fsWalkNested(builtins, root) : fsWalkFlat(builtins, root);
      source = Object.keys(modules).length > 0 ? "fs" : "empty";
    } else {
      modules = {};
      source = "empty";
    }
  }
  const entries = [];
  for (const [rawKey, content] of Object.entries(modules)) {
    if (typeof content !== "string") continue;
    const key = normalizeKey(rawKey, anchor);
    if (skip && skip(key)) continue;
    entries.push({ id: toCorpusId(key, anchor), key, content });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { source, entries };
}
function corpusSkills(corpus, anchor) {
  return corpus.map(
    (entry) => ({
      path: `${anchor}/${entry.id}.md`,
      resource: inlineResource(`${anchor}-${entry.id}`, entry.content)
    })
  ).sort((a, b) => a.path.localeCompare(b.path));
}
function registrySkills(registry, tier = "free") {
  return registry.filter((s) => s.tier === tier).map(
    (s) => ({
      path: skillMountPath(s.id),
      resource: inlineResource(s.id, s.skillMd)
    })
  ).sort((a, b) => a.path.localeCompare(b.path));
}
function composeShellResources(input) {
  const { skills = [], knowledge = [], evolvable = [], registry = [], predicate } = input;
  const composed = [...skills, ...knowledge, ...evolvable, ...registry];
  return predicate ? composed.filter(predicate) : composed;
}
function parseFrontmatterScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  return trimmed;
}
function parseSkillFrontmatter(raw) {
  const lines = raw.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    return { frontmatter: {}, body: raw, raw };
  }
  let closeIndex = -1;
  for (let i2 = 1; i2 < lines.length; i2++) {
    if ((lines[i2] ?? "").trim() === "---") {
      closeIndex = i2;
      break;
    }
  }
  if (closeIndex === -1) {
    throw new Error(
      'parseSkillFrontmatter: opening "---" has no closing "---" \u2014 truncated frontmatter block'
    );
  }
  const blockLines = lines.slice(1, closeIndex);
  const body = lines.slice(closeIndex + 1).join("\n").replace(/^\n+/, "");
  const frontmatter = {};
  const scalarKeys = /* @__PURE__ */ new Set(["id", "name", "description", "source", "category", "tier"]);
  const topLineRe = /^(\S[^:]*):\s*(.*)$/;
  let i = 0;
  while (i < blockLines.length) {
    const line = blockLines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const match = line.match(topLineRe);
    if (!match) {
      throw new Error(`parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(line)}`);
    }
    const key = (match[1] ?? "").trim();
    const rest = match[2] ?? "";
    if (key === "author") {
      if (rest.trim() !== "") {
        throw new Error(`parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(line)}`);
      }
      const author = { name: "" };
      let sawName = false;
      i++;
      while (i < blockLines.length && /^\s+\S/.test(blockLines[i] ?? "")) {
        const sub = (blockLines[i] ?? "").trim();
        const subMatch = sub.match(/^(name|url):\s*(.*)$/);
        if (!subMatch) {
          throw new Error(
            `parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(blockLines[i])}`
          );
        }
        const subKey = subMatch[1];
        const subValue = parseFrontmatterScalar(subMatch[2] ?? "");
        if (subKey === "name") {
          author.name = subValue;
          sawName = true;
        } else {
          author.url = subValue;
        }
        i++;
      }
      if (sawName) frontmatter.author = author;
      continue;
    }
    if (key === "tags") {
      const inline = rest.trim();
      if (inline.startsWith("[") && inline.endsWith("]")) {
        const inner = inline.slice(1, -1).trim();
        frontmatter.tags = inner === "" ? [] : inner.split(",").map((t) => parseFrontmatterScalar(t));
        i++;
        continue;
      }
      if (inline !== "") {
        throw new Error(`parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(line)}`);
      }
      const tags = [];
      i++;
      while (i < blockLines.length && /^\s*-\s*/.test(blockLines[i] ?? "")) {
        tags.push(parseFrontmatterScalar((blockLines[i] ?? "").replace(/^\s*-\s*/, "")));
        i++;
      }
      frontmatter.tags = tags;
      continue;
    }
    if (scalarKeys.has(key)) {
      ;
      frontmatter[key] = parseFrontmatterScalar(rest);
    }
    i++;
  }
  return { frontmatter, body, raw };
}
function skillEntryFromMarkdown(raw, fallbackId) {
  const { frontmatter } = parseSkillFrontmatter(raw);
  const id = frontmatter.id ?? fallbackId;
  if (!id) {
    throw new Error(
      'skillEntryFromMarkdown: no "id" in frontmatter and no fallbackId supplied \u2014 cannot build a SkillEntry'
    );
  }
  const entry = {
    id,
    name: frontmatter.name ?? id,
    description: frontmatter.description ?? "",
    tier: frontmatter.tier ?? "free",
    skillMd: raw
  };
  if (frontmatter.author) entry.author = frontmatter.author;
  if (frontmatter.source) entry.source = frontmatter.source;
  if (frontmatter.category) entry.category = frontmatter.category;
  if (frontmatter.tags) entry.tags = frontmatter.tags;
  return entry;
}
function parseCorpusSkills(corpus) {
  return corpus.map((entry) => skillEntryFromMarkdown(entry.content, entry.id));
}
function skillRefs(skills, opts = {}) {
  const filtered = opts.tier ? skills.filter((s) => s.tier === opts.tier) : skills;
  return [...filtered].sort((a, b) => a.id.localeCompare(b.id)).map((s) => inlineResource(s.id, s.skillMd));
}
function renderInlineSkillBody(skill) {
  const { body } = parseSkillFrontmatter(skill.skillMd);
  return `### ${skill.name}

${body.trim()}`;
}
function renderInlineSkills(input) {
  const heading = input.heading ?? "## Skills";
  const filtered = input.tier ? input.skills.filter((s) => s.tier === input.tier) : input.skills;
  if (filtered.length === 0) return "";
  const renderBody = input.body ?? renderInlineSkillBody;
  return `

${heading}

${filtered.map(renderBody).join("\n\n")}`;
}
function renderSkillIndex(input) {
  const heading = input.heading ?? "## Skills";
  const filtered = input.tier ? input.skills.filter((s) => s.tier === input.tier) : input.skills;
  if (filtered.length === 0) return "";
  const lines = filtered.map(
    (s) => `- ${s.name}: ${s.description} (read ${input.skillDir}/${s.id}/SKILL.md)`
  );
  return `

${heading}

${lines.join("\n")}`;
}
function composeSkills(input) {
  const { skills, mode, tier, heading } = input;
  const deliveredIds = (tier ? skills.filter((s) => s.tier === tier) : skills).map((s) => s.id);
  if (mode === "inline") {
    return {
      refs: [],
      promptSection: renderInlineSkills({ skills, tier, heading }),
      inlineIds: deliveredIds,
      mountedIds: []
    };
  }
  if (!input.skillDir) {
    throw new Error(
      'composeSkills: mode "mounted" requires a non-null skillDir \u2014 this harness cannot receive skill files at a cwd path; pass mode "inline" instead'
    );
  }
  return {
    refs: skillRefs(skills, { tier }),
    promptSection: renderSkillIndex({ skills, skillDir: input.skillDir, tier, heading }),
    inlineIds: [],
    mountedIds: deliveredIds
  };
}
function assertSkillDeliveryDisjoint(inlineIds, mountedIds) {
  const inline = new Set(inlineIds);
  const overlap = [...new Set(mountedIds)].filter((id) => inline.has(id));
  if (overlap.length > 0) {
    throw new Error(
      `assertSkillDeliveryDisjoint: skill id(s) delivered both inline and mounted: ${overlap.join(", ")}`
    );
  }
}
function mergeComposedSkills(batches) {
  const merged = {
    refs: batches.flatMap((b) => b.refs),
    promptSection: batches.map((b) => b.promptSection).join(""),
    inlineIds: batches.flatMap((b) => b.inlineIds),
    mountedIds: batches.flatMap((b) => b.mountedIds)
  };
  assertSkillDeliveryDisjoint(merged.inlineIds, merged.mountedIds);
  return merged;
}

export {
  skillMountPath,
  loadMarkdownCorpus,
  corpusSkills,
  registrySkills,
  composeShellResources,
  parseSkillFrontmatter,
  skillEntryFromMarkdown,
  parseCorpusSkills,
  skillRefs,
  renderInlineSkills,
  renderSkillIndex,
  composeSkills,
  assertSkillDeliveryDisjoint,
  mergeComposedSkills
};
//# sourceMappingURL=chunk-M3UFMQ7D.js.map