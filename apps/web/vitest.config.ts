import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": at("./src"),
      "@cubers/types": at("../../packages/types/src/index.ts"),
      "@cubers/scramble-core": at("../../packages/scramble-core/src/index.ts"),
      "@cubers/timer-core": at("../../packages/timer-core/src/index.ts"),
    },
  },
});
