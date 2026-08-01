/**
 * Import an optional embedding-provider dependency with an actionable failure.
 *
 * Both providers reach their SDK through a dynamic `import()`, and `openai` was
 * not declared in package.json at all — so selecting `provider: "openai"`, a
 * first-class config option with six dedicated keys, crashed any fresh install
 * with a raw ESM `ERR_MODULE_NOT_FOUND` stack trace naming an internal file
 * path and nothing the operator could act on.
 *
 * `@xenova/transformers` is declared, but only as an OPTIONAL dependency, so an
 * `npm install --omit=optional` reaches the identical dead end. Neither path
 * should surface a resolver stack trace.
 */
export async function importOptional(packageName, providerName) {
  try {
    return await import(packageName);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw Object.assign(
        new Error(
          `embedding provider '${providerName}' requires the optional '${packageName}' package — ` +
          `run: npm install ${packageName}`
        ),
        { code: 'CCMEM_OPTIONAL_DEP_MISSING', cause: err }
      );
    }
    throw err;
  }
}
