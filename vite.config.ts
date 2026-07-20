import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  test: {
    // Claude Code task worktrees live under .claude/worktrees and contain a
    // full copy of tests/; keep vitest scoped to this checkout only.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4100",
    },
  },
});
