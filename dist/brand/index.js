// src/brand/index.tsx
import {
  Logo as CanonicalLogo,
  TangleKnot
} from "@tangle-network/brand";
import { jsx, jsxs } from "react/jsx-runtime";
function Logo({
  variant = "sandbox",
  size = "md",
  className,
  iconOnly = false
}) {
  void variant;
  return /* @__PURE__ */ jsx(
    CanonicalLogo,
    {
      size,
      variant: iconOnly ? "icon" : "full",
      className
    }
  );
}
function BrandHeader({ title, children, className }) {
  return /* @__PURE__ */ jsxs(
    "header",
    {
      className: `flex shrink-0 items-center gap-3 border-b border-border bg-card px-4 py-2${className ? ` ${className}` : ""}`,
      children: [
        /* @__PURE__ */ jsxs("span", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ jsx(TangleKnot, { size: 24, className: "shrink-0" }),
          title ? /* @__PURE__ */ jsx("span", { className: "text-sm font-semibold text-foreground", children: title }) : null
        ] }),
        children ? /* @__PURE__ */ jsx("div", { className: "flex flex-1 items-center justify-end gap-1", children }) : null
      ]
    }
  );
}
export {
  BrandHeader,
  Logo,
  TangleKnot
};
//# sourceMappingURL=index.js.map