import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app.tsx";
import "@/index.css";

const rootEl = document.getElementById("root");
if (rootEl === null) throw new Error("warren UI: #root element missing from index.html");
createRoot(rootEl).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
