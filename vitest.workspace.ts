import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "apps/api",
  "apps/web",
  "packages/timer-core",
  "packages/scramble-core",
]);
