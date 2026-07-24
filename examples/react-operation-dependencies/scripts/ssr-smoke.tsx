import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import App from "../src/App.js";

const html = renderToString(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (!html.includes("Components require operations")) {
  throw new Error("SSR did not render the operation-dependency shell");
}

console.log("React SSR smoke passed without source acquisition or invocation");
