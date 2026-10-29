import { render } from "preact";
import { App } from "./App.tsx";
import { connect } from "./store.ts";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("The page has no #app element.");
// The style guide shows fixtures only, so it never opens the live connection; it loads as its own chunk.
if (location.pathname === "/neo-brutalism") {
  void import("./StyleGuide.tsx").then(({ StyleGuide }) => render(<StyleGuide />, root));
} else {
  connect();
  render(<App />, root);
}
