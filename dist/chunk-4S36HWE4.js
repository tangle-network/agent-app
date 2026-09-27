// src/design-canvas-react/lazy.tsx
import { lazy } from "react";
var DesignCanvasLazy = lazy(
  () => import("./DesignCanvasEditor-4QWY2LHM.js").then((m) => ({ default: m.DesignCanvasEditor }))
);
var DesignCanvasChromeLazy = lazy(
  () => import("./DesignCanvas-YLVDCX6H.js").then((m) => ({ default: m.DesignCanvas }))
);

export {
  DesignCanvasLazy,
  DesignCanvasChromeLazy
};
//# sourceMappingURL=chunk-4S36HWE4.js.map