// Preview artifacts may be produced only from these explicitly reviewed branches.
// The production branch is intentionally not included.
export const PREVIEW_BRANCHES = Object.freeze([
  "dagul/isolated-worker-preview",
  "dagul/classifier-readiness-integration",
]);

export const DEFAULT_PREVIEW_BRANCH = PREVIEW_BRANCHES[0];
export const isPreviewBranch = branch => PREVIEW_BRANCHES.includes(branch);
