import { createRoot } from "react-dom/client";
import "../../src/styles/globals.css";
import "./options.css";
import { App } from "./App";
import { initExtensionStorage } from "../../src/components/AppProviders";

initExtensionStorage().then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
