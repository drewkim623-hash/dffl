// Node loader hook so test-worker.mjs can import src/ as-is: wrangler (esbuild)
// bundles bare `import x from "./file.json"`, node needs an attribute.
export async function load(url, context, next) {
  if (url.endsWith(".json")) {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL(url), "utf8");
    return { format: "module", source: `export default ${src};`, shortCircuit: true };
  }
  return next(url, context);
}
