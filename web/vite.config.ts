import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies the bridge's two network surfaces (WebSocket + /api) to a locally running
// `omp-webchat` server, so `npm run dev` drives a real session instead of a mock.
// Default bridge port; `omp-webchat --port N` moves it, so change it here if you use another.
const BRIDGE = "http://127.0.0.1:7788";

export default defineConfig({
	plugins: [react()],
	build: { target: "es2020", cssCodeSplit: true },
	server: {
		proxy: {
			"/api": { target: BRIDGE, changeOrigin: true },
			"/ws": { target: BRIDGE.replace(/^http/, "ws"), ws: true },
		},
	},
});
