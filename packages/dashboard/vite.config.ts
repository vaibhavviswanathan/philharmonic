import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3200,
    proxy: {
      "/v1": "http://localhost:3100",
      "/health": "http://localhost:3100",
    },
  },
});
