const version = process.env.REWORK_01_IMPL ?? "v1";
if (version !== "v1" && version !== "v2") {
  throw new Error("REWORK_01_IMPL must be v1 or v2");
}

export const { normalizeLabels } = await import(`../src/labels-${version}.mjs`);
