import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "harness", "view-bundle", "dist");
await mkdir(target, { recursive: true });
for (const folder of ["core", "ui"]) await cp(join(root, "dist", folder), join(target, folder), { recursive: true });
await cp(join(root, "harness/view-index.mjs"), join(root, "harness/view-bundle/index.mjs"));
console.log(`view bundle: ${target}`);
