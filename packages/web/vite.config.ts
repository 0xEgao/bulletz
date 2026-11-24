import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ command, mode }) => ({
  plugins: [react()],
  // The standalone desktop build can bundle this module before shared/dist exists.
  resolve: {
    alias: {
      "@bulletz/shared/github": fileURLToPath(new URL("../shared/src/github.ts", import.meta.url)),
    },
  },
  // Relative, because the same bundle is loaded two ways: served over http
  // from the server, and opened over file:// by the packaged desktop app.
  // An absolute base resolves to the filesystem root under file:// and the
  // window comes up blank.
  base: "./",
  server: { port: 5174, strictPort: true },
  define: {
    // VITE_BULLETZ_TOKEN is a local convenience that keeps the dev server from
    // stopping at the login screen. Vite loads .env.local in every mode, so
    // without this a production build silently embeds a real API token in a
    // file meant to be handed to other people. It has to be stripped here, not
    // remembered.
    ...(command === "build" ? { "import.meta.env.VITE_BULLETZ_TOKEN": "undefined" } : {}),
    // Distribution ignores the developer's pinned web server.
    ...(mode === "package" ? { "import.meta.env.VITE_BULLETZ_URL": "undefined" } : {}),
  },
}));
