import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource-variable/jetbrains-mono";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createApiClient } from "./adapters/api-client.ts";
import { useHistoryRouter } from "./adapters/history.ts";
import { realtime } from "./adapters/realtime.ts";
import { useWorkspace } from "./application/workspace.ts";
import { AppView } from "./ui/AppView.tsx";
import "./ui/styles.css";

const api = createApiClient();

function Root() {
  const navigation = useHistoryRouter();
  const workspace = useWorkspace({ api, realtime, navigation });
  return <AppView workspace={workspace} />;
}

const root = document.querySelector<HTMLElement>("#root");

if (root === null) {
  throw new Error("missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
