// Offline test adapter only. The application itself uses ordinary package imports.
import { registerHooks } from "node:module";
const backendParent = new URL("../../backend/package.json", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@earendil-works/"))
      return nextResolve(specifier, { ...context, parentURL: backendParent });
    return nextResolve(specifier, context);
  },
});
