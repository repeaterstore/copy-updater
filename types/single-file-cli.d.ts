/**
 * SingleFile ships no type declarations. Its browser bundle exports strings of
 * JavaScript to be injected into a page, not runnable module code.
 */
declare module "single-file-cli/lib/single-file-bundle.js" {
  /** Defines the `singlefile` global when injected into a page. */
  export const script: string;
  /** Patches page APIs; must run before the page's own scripts. */
  export const hookScript: string;
  export const zipScript: string;
}
