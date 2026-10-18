import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./store";
import "./fonts";
import "./styles.css";

// The socket is opened once, outside React: a StrictMode double mount must not open two.
store.start();

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
createRoot(root).render(<App />);
