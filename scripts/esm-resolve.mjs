/** Dev-only ESM loader: resolves reqly's extensionless dist imports in plain Node. */
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith(".") &&
    !/\.(js|mjs|cjs|json|wasm)$/.test(specifier)
  ) {
    return nextResolve(`${specifier}.js`, context)
  }
  return nextResolve(specifier, context)
}

/** The benchmark exercises the pure-JS backend; stub the WASM asset for Node. */
export async function load(url, context, nextLoad) {
  if (url.endsWith(".wasm")) {
    return { format: "module", source: "export default undefined", shortCircuit: true }
  }
  return nextLoad(url, context)
}
