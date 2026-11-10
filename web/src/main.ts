// Entry point for the web client. The board lands in LAS-152; this keeps the
// web typecheck project real until then.
const root = document.querySelector<HTMLElement>("#app");

if (root !== null) {
  root.textContent = "Curved";
}

export {};
