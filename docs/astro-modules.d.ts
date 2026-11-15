/**
 * Types for `.astro` imports in the site's TypeScript files, such as
 * components.ts. Astro's own checker reads each component's real props; this
 * covers TypeScript-only checks, such as Oxlint's type-checked lint, that
 * can't read `.astro` files.
 */
declare module "*.astro" {
  import type { AstroComponentFactory } from "astro/runtime/server/index.js";

  const component: AstroComponentFactory;

  export default component;
}
