import { render } from "preact";
import { App } from "./App.tsx";
import { connect } from "./store.ts";
import "./styles.css";

connect();
const root = document.getElementById("app");
if (!root) throw new Error("The page has no #app element.");
render(<App />, root);
