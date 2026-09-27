// src/web/file-export.ts
function isWorkspaceFileExportable(path) {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => {
    if (!segment || segment.startsWith(".")) return false;
    const name = segment.toLowerCase();
    return name !== "opencode.json" && name !== "opencode.jsonc";
  });
}

export {
  isWorkspaceFileExportable
};
//# sourceMappingURL=chunk-TXD5HXLE.js.map