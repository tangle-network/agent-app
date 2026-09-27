import {
  applySceneOperation,
  applySceneOperations,
  requireElement,
  requirePage
} from "./chunk-BWQPVS7D.js";

// src/design-canvas-react/engine/command-stack.ts
var SCENE_COMMAND_HISTORY_LIMIT = 200;
function createSceneCommandStack(document, activePageId) {
  let state = {
    document,
    activePageId,
    selectedElementIds: [],
    zoom: 1,
    panX: 0,
    panY: 0,
    gridEnabled: false,
    gridSize: 10,
    snapEnabled: true,
    showRulers: true,
    showBleed: false
  };
  const undoStack = [];
  const redoStack = [];
  const listeners = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    execute(command) {
      state = command.execute(state);
      undoStack.push(command);
      if (undoStack.length > SCENE_COMMAND_HISTORY_LIMIT) {
        undoStack.splice(0, undoStack.length - SCENE_COMMAND_HISTORY_LIMIT);
      }
      redoStack.length = 0;
      notify();
    },
    // Both transforms run BEFORE the stacks move: a throwing transform (e.g.
    // missing element after reset()) leaves history and state exactly as they
    // were. The entry is never silently destroyed — the caller can retry after
    // the next server refresh restores the target.
    undo() {
      const command = undoStack[undoStack.length - 1];
      if (!command) throw new Error("nothing to undo \u2014 guard with canUndo() before calling undo()");
      state = command.undo(state);
      undoStack.pop();
      redoStack.push(command);
      notify();
      return command;
    },
    redo() {
      const command = redoStack[redoStack.length - 1];
      if (!command) throw new Error("nothing to redo \u2014 guard with canRedo() before calling redo()");
      state = command.execute(state);
      redoStack.pop();
      undoStack.push(command);
      notify();
      return command;
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState() {
      return state;
    },
    setView(patch) {
      state = { ...state, ...patch };
      notify();
    },
    // A persisted UNDO rejected: the server still has `command` applied, but the
    // local undo already removed it (and a later execute may have cleared the
    // redo stack). Deterministically re-converge — mirror of `rollback`, in the
    // forward direction: re-apply the command's FORWARD transform to current
    // state and ensure it lives on the undo stack (so a later undo can remove it
    // again). Idempotent: if the command is already on the undo stack (the undo
    // never actually left local history), this is a no-op. For disjoint edits the
    // forward transform commutes past commands executed while the undo was
    // pending, so their net effect is preserved.
    reexecute(command) {
      if (undoStack.includes(command)) return;
      state = command.execute(state);
      const redoIdx = redoStack.lastIndexOf(command);
      if (redoIdx !== -1) redoStack.splice(redoIdx, 1);
      undoStack.push(command);
      notify();
    },
    // A persisted REDO rejected: the server does NOT have `command` applied, but
    // the local redo just applied it forward and put it on the undo stack.
    // Re-apply its INVERSE and move it to the redo stack — the redo-side mirror
    // of `reexecute`. No-op if the command is not on the undo stack.
    reundo(command) {
      const undoIdx = undoStack.lastIndexOf(command);
      if (undoIdx === -1) return;
      state = command.undo(state);
      undoStack.splice(undoIdx, 1);
      if (!redoStack.includes(command)) redoStack.push(command);
      notify();
    },
    rollback(command) {
      const idx = undoStack.lastIndexOf(command);
      if (idx === -1) return;
      state = command.undo(state);
      undoStack.splice(idx, 1);
      redoStack.length = 0;
      notify();
    },
    /** Rebase onto a server-refreshed document. History survives; selection
     *  drops ids the refresh removed so view state never dangles. */
    reset(newDocument) {
      const liveElementIds = /* @__PURE__ */ new Set();
      for (const page of newDocument.pages) {
        collectElementIds(page.elements, liveElementIds);
      }
      const activePageExists = newDocument.pages.some((p) => p.id === state.activePageId);
      const activePageId2 = activePageExists ? state.activePageId : newDocument.pages[0]?.id ?? state.activePageId;
      state = {
        ...state,
        document: newDocument,
        activePageId: activePageId2,
        selectedElementIds: state.selectedElementIds.filter((id) => liveElementIds.has(id))
      };
      notify();
    }
  };
}
function collectElementIds(elements, ids) {
  for (const el of elements) {
    ids.add(el.id);
    if (el.kind === "group" && Array.isArray(el.children)) {
      collectElementIds(el.children, ids);
    }
  }
}

// src/design-canvas-react/engine/commands.ts
function applyOps(state, ops) {
  return { ...state, document: applySceneOperations(state.document, ops) };
}
function applyOp(state, op) {
  return { ...state, document: applySceneOperation(state.document, op) };
}
function addElementCommand(input) {
  const addOp = {
    type: "add_element",
    pageId: input.pageId,
    element: structuredClone(input.element),
    ...input.index !== void 0 ? { index: input.index } : {},
    ...input.parentGroupId !== void 0 ? { parentGroupId: input.parentGroupId } : {}
  };
  const deleteOp = {
    type: "delete_element",
    pageId: input.pageId,
    elementId: input.element.id
  };
  return {
    label: `Add ${input.element.kind}`,
    execute: (state) => applyOp(state, addOp),
    undo: (state) => applyOp(state, deleteOp),
    operations: () => [structuredClone(addOp)],
    inverseOperations: () => [structuredClone(deleteOp)]
  };
}
function setAttrsCommand(input) {
  const forwardOp = {
    type: "set_attrs",
    pageId: input.pageId,
    elementId: input.elementId,
    attrs: structuredClone(input.attrs)
  };
  const inverseOp = {
    type: "set_attrs",
    pageId: input.pageId,
    elementId: input.elementId,
    attrs: structuredClone(input.priorAttrs)
  };
  return {
    label: "Edit element",
    execute: (state) => applyOp(state, forwardOp),
    undo: (state) => applyOp(state, inverseOp),
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => [structuredClone(inverseOp)]
  };
}
function multiSetAttrsCommand(entries) {
  if (entries.length === 0) throw new Error("multiSetAttrsCommand: entries must not be empty");
  const forwardOps = entries.map((e) => ({
    type: "set_attrs",
    pageId: e.pageId,
    elementId: e.elementId,
    attrs: structuredClone(e.attrs)
  }));
  const inverseOps = entries.map((e) => ({
    type: "set_attrs",
    pageId: e.pageId,
    elementId: e.elementId,
    attrs: structuredClone(e.priorAttrs)
  }));
  return {
    label: `Edit ${entries.length} elements`,
    execute: (state) => applyOps(state, forwardOps),
    undo: (state) => applyOps(state, inverseOps),
    operations: () => structuredClone(forwardOps),
    inverseOperations: () => structuredClone(inverseOps)
  };
}
function reorderElementCommand(input) {
  let capturedFromIndex = null;
  const forwardOp = {
    type: "reorder_element",
    pageId: input.pageId,
    elementId: input.elementId,
    toIndex: input.toIndex
  };
  return {
    label: "Reorder element",
    execute: (state) => {
      if (capturedFromIndex === null) {
        const page = requirePage(state.document, input.pageId);
        const { index } = requireElement(page, input.elementId);
        capturedFromIndex = index;
      }
      return applyOp(state, forwardOp);
    },
    undo: (state) => {
      if (capturedFromIndex === null) {
        throw new Error("reorderElementCommand: undo called before execute");
      }
      return applyOp(state, {
        type: "reorder_element",
        pageId: input.pageId,
        elementId: input.elementId,
        toIndex: capturedFromIndex
      });
    },
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => {
      if (capturedFromIndex === null) {
        throw new Error("reorderElementCommand: inverseOperations called before execute");
      }
      return [{
        type: "reorder_element",
        pageId: input.pageId,
        elementId: input.elementId,
        toIndex: capturedFromIndex
      }];
    }
  };
}
function deleteElementCommand(input) {
  const page = requirePage(input.document, input.pageId);
  const { element, owner, index } = requireElement(page, input.elementId);
  const snapshot = structuredClone(element);
  const parentGroupId = findParentGroupId(page, owner);
  const deleteOp = {
    type: "delete_element",
    pageId: input.pageId,
    elementId: input.elementId
  };
  const addOp = {
    type: "add_element",
    pageId: input.pageId,
    element: snapshot,
    index,
    ...parentGroupId !== void 0 ? { parentGroupId } : {}
  };
  return {
    label: `Delete ${element.kind}`,
    execute: (state) => {
      const next = applyOp(state, deleteOp);
      return {
        ...next,
        selectedElementIds: next.selectedElementIds.filter((id) => id !== input.elementId)
      };
    },
    undo: (state) => applyOp(state, addOp),
    operations: () => [structuredClone(deleteOp)],
    inverseOperations: () => [structuredClone(addOp)]
  };
}
function findParentGroupId(page, owner) {
  if (owner === page.elements) return void 0;
  return findGroupWithChildren(page.elements, owner);
}
function findGroupWithChildren(elements, target) {
  for (const el of elements) {
    if (el.kind === "group") {
      if (el.children === target) return el.id;
      const found = findGroupWithChildren(el.children, target);
      if (found !== void 0) return found;
    }
  }
  return void 0;
}
function groupElementsCommand(input) {
  if (input.elementIds.length < 2) {
    throw new Error("groupElementsCommand: requires \u2265 2 elementIds");
  }
  const groupOp = {
    type: "group_elements",
    pageId: input.pageId,
    elementIds: input.elementIds.slice(),
    groupId: input.groupId,
    ...input.name !== void 0 ? { name: input.name } : {}
  };
  const ungroupOp = {
    type: "ungroup_element",
    pageId: input.pageId,
    groupId: input.groupId
  };
  return {
    label: `Group ${input.elementIds.length} elements`,
    execute: (state) => {
      const next = applyOp(state, groupOp);
      return {
        ...next,
        selectedElementIds: [input.groupId]
      };
    },
    undo: (state) => {
      const next = applyOp(state, ungroupOp);
      return { ...next, selectedElementIds: input.elementIds.slice() };
    },
    operations: () => [structuredClone(groupOp)],
    inverseOperations: () => [structuredClone(ungroupOp)]
  };
}
function ungroupElementCommand(input) {
  const page = requirePage(input.document, input.pageId);
  const { element } = requireElement(page, input.groupId);
  if (element.kind !== "group") {
    throw new Error(`ungroupElementCommand: element ${input.groupId} is kind ${element.kind}, not group`);
  }
  const childIds = element.children.map((c) => c.id);
  const ungroupOp = {
    type: "ungroup_element",
    pageId: input.pageId,
    groupId: input.groupId
  };
  const regroupOp = {
    type: "group_elements",
    pageId: input.pageId,
    elementIds: childIds,
    groupId: input.groupId,
    name: element.name
  };
  return {
    label: `Ungroup`,
    execute: (state) => {
      const next = applyOp(state, ungroupOp);
      return { ...next, selectedElementIds: childIds.slice() };
    },
    undo: (state) => {
      const next = applyOp(state, regroupOp);
      return { ...next, selectedElementIds: [input.groupId] };
    },
    operations: () => [structuredClone(ungroupOp)],
    inverseOperations: () => [structuredClone(regroupOp)]
  };
}
function addPageCommand(input) {
  const addOp = {
    type: "add_page",
    pageId: input.pageId,
    ...input.options !== void 0 ? { options: input.options } : {},
    ...input.index !== void 0 ? { index: input.index } : {}
  };
  const deleteOp = { type: "delete_page", pageId: input.pageId };
  return {
    label: "Add page",
    execute: (state) => {
      const next = applyOp(state, addOp);
      return { ...next, activePageId: input.pageId };
    },
    undo: (state) => {
      const next = applyOp(state, deleteOp);
      const activeExists = next.document.pages.some((p) => p.id === next.activePageId);
      return activeExists ? next : { ...next, activePageId: next.document.pages[0].id };
    },
    operations: () => [structuredClone(addOp)],
    inverseOperations: () => [structuredClone(deleteOp)]
  };
}
function duplicatePageCommand(input) {
  requirePage(input.document, input.sourcePageId);
  const dupOp = {
    type: "duplicate_page",
    sourcePageId: input.sourcePageId,
    pageId: input.pageId
  };
  const deleteOp = { type: "delete_page", pageId: input.pageId };
  return {
    label: "Duplicate page",
    execute: (state) => {
      const next = applyOp(state, dupOp);
      return { ...next, activePageId: input.pageId };
    },
    undo: (state) => {
      const next = applyOp(state, deleteOp);
      const activeExists = next.document.pages.some((p) => p.id === next.activePageId);
      return activeExists ? next : { ...next, activePageId: input.sourcePageId };
    },
    operations: () => [structuredClone(dupOp)],
    inverseOperations: () => [structuredClone(deleteOp)]
  };
}
function deletePageCommand(input) {
  if (input.document.pages.length <= 1) {
    throw new Error("deletePageCommand: cannot delete the last page");
  }
  const page = requirePage(input.document, input.pageId);
  const currentIndex = input.document.pages.findIndex((p) => p.id === input.pageId);
  const snapshot = structuredClone(page);
  const deleteOp = { type: "delete_page", pageId: input.pageId };
  function buildRestoreOps() {
    const ops = [
      {
        type: "add_page",
        pageId: snapshot.id,
        options: {
          name: snapshot.name,
          width: snapshot.width,
          height: snapshot.height,
          background: snapshot.background
        },
        index: currentIndex
      }
    ];
    if (snapshot.bleed) {
      ops.push({ type: "set_page_props", pageId: snapshot.id, bleed: snapshot.bleed });
    }
    if (snapshot.guides.vertical.length > 0 || snapshot.guides.horizontal.length > 0) {
      ops.push({ type: "set_page_guides", pageId: snapshot.id, guides: snapshot.guides });
    }
    for (let i = 0; i < snapshot.elements.length; i++) {
      ops.push({
        type: "add_element",
        pageId: snapshot.id,
        element: structuredClone(snapshot.elements[i]),
        index: i
      });
    }
    return ops;
  }
  return {
    label: "Delete page",
    execute: (state) => {
      const next = applyOp(state, deleteOp);
      const activeExists = next.document.pages.some((p) => p.id === next.activePageId);
      if (activeExists) return next;
      const fallbackIndex = Math.min(currentIndex, next.document.pages.length - 1);
      return { ...next, activePageId: next.document.pages[fallbackIndex].id };
    },
    undo: (state) => {
      const next = applyOps(state, buildRestoreOps());
      return { ...next, activePageId: input.pageId };
    },
    operations: () => [structuredClone(deleteOp)],
    inverseOperations: () => buildRestoreOps()
  };
}
function reorderPageCommand(input) {
  let capturedFromIndex = null;
  const forwardOp = {
    type: "reorder_page",
    pageId: input.pageId,
    toIndex: input.toIndex
  };
  return {
    label: "Reorder page",
    execute: (state) => {
      if (capturedFromIndex === null) {
        capturedFromIndex = state.document.pages.findIndex((p) => p.id === input.pageId);
        if (capturedFromIndex === -1) throw new Error(`reorderPageCommand: page ${input.pageId} not found`);
      }
      return applyOp(state, forwardOp);
    },
    undo: (state) => {
      if (capturedFromIndex === null) throw new Error("reorderPageCommand: undo called before execute");
      return applyOp(state, {
        type: "reorder_page",
        pageId: input.pageId,
        toIndex: capturedFromIndex
      });
    },
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => {
      if (capturedFromIndex === null) throw new Error("reorderPageCommand: inverseOperations called before execute");
      return [{ type: "reorder_page", pageId: input.pageId, toIndex: capturedFromIndex }];
    }
  };
}
function setPagePropsCommand(input) {
  const page = requirePage(input.document, input.pageId);
  const prior = {
    type: "set_page_props",
    pageId: input.pageId,
    ...input.props.name !== void 0 ? { name: page.name } : {},
    ...input.props.width !== void 0 ? { width: page.width } : {},
    ...input.props.height !== void 0 ? { height: page.height } : {},
    ...input.props.background !== void 0 ? { background: page.background } : {},
    ...input.props.bleed !== void 0 ? { bleed: page.bleed } : {}
  };
  const forwardOp = {
    type: "set_page_props",
    pageId: input.pageId,
    ...input.props
  };
  return {
    label: "Edit page",
    execute: (state) => applyOp(state, forwardOp),
    undo: (state) => applyOp(state, prior),
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => [structuredClone(prior)]
  };
}
function setPageGuidesCommand(input) {
  const page = requirePage(input.document, input.pageId);
  const priorGuides = structuredClone(page.guides);
  const forwardOp = {
    type: "set_page_guides",
    pageId: input.pageId,
    guides: structuredClone(input.guides)
  };
  const inverseOp = {
    type: "set_page_guides",
    pageId: input.pageId,
    guides: priorGuides
  };
  return {
    label: "Edit guides",
    execute: (state) => applyOp(state, forwardOp),
    undo: (state) => applyOp(state, inverseOp),
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => [structuredClone(inverseOp)]
  };
}
function bindSlotCommand(input) {
  const page = requirePage(input.document, input.pageId);
  const { element } = requireElement(page, input.elementId);
  const priorSlot = element.slot ?? null;
  const forwardOp = {
    type: "bind_slot",
    pageId: input.pageId,
    elementId: input.elementId,
    slot: input.slot
  };
  const inverseOp = {
    type: "bind_slot",
    pageId: input.pageId,
    elementId: input.elementId,
    slot: priorSlot
  };
  return {
    label: input.slot === null ? "Unbind slot" : `Bind slot "${input.slot}"`,
    execute: (state) => applyOp(state, forwardOp),
    undo: (state) => applyOp(state, inverseOp),
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => [structuredClone(inverseOp)]
  };
}
function setDocumentTitleCommand(input) {
  const priorTitle = input.document.title;
  const forwardOp = { type: "set_document_title", title: input.title };
  const inverseOp = { type: "set_document_title", title: priorTitle };
  return {
    label: `Rename document`,
    execute: (state) => applyOp(state, forwardOp),
    undo: (state) => applyOp(state, inverseOp),
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => [structuredClone(inverseOp)]
  };
}

export {
  SCENE_COMMAND_HISTORY_LIMIT,
  createSceneCommandStack,
  addElementCommand,
  setAttrsCommand,
  multiSetAttrsCommand,
  reorderElementCommand,
  deleteElementCommand,
  groupElementsCommand,
  ungroupElementCommand,
  addPageCommand,
  duplicatePageCommand,
  deletePageCommand,
  reorderPageCommand,
  setPagePropsCommand,
  setPageGuidesCommand,
  bindSlotCommand,
  setDocumentTitleCommand
};
//# sourceMappingURL=chunk-FEVVF6JJ.js.map