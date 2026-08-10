import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "apps/api",
  "packages/timer-core",
  "packages/scramble-core",
]);
