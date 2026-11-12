// Public provenance shared by the GitHub publisher and Cloudflare consumer.
export const REPOSITORY = "agentbeau/sub2api";
export const REPOSITORY_ID = 1453664051;
export const CI_WORKFLOW = ".github/workflows/ci.yml";
export const ARTIFACT_NAMES = Object.freeze(["container-worker", "container-image"]);
export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const id = value => Number.isSafeInteger(value) && value > 0;
const repository = value => value?.id === REPOSITORY_ID && value?.full_name === REPOSITORY;

export function validateRun(run, revision, workflowId) {
  if (!SHA.test(revision ?? "") || !id(workflowId) || !id(run?.id) || !id(run.run_attempt)
    || !repository(run.repository) || !repository(run.head_repository)
    || run.head_sha !== revision || run.head_branch !== "main" || run.event !== "push"
    || run.path !== CI_WORKFLOW || run.workflow_id !== workflowId
    || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("Expected a successful trusted-main ci.yml push run for this exact revision");
  }
  return run;
}

export function validateArtifact(artifact, run, name) {
  const source = artifact?.workflow_run;
  if (!ARTIFACT_NAMES.includes(name) || artifact?.name !== name || !id(artifact.id)
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > MAX_ARTIFACT_BYTES
    || !DIGEST.test(artifact.digest ?? "") || source?.id !== run.id
    || source.repository_id !== REPOSITORY_ID || source.head_repository_id !== REPOSITORY_ID
    || source.head_branch !== "main" || source.head_sha !== run.head_sha) {
    throw new Error(`Invalid original Actions provenance for ${name}`);
  }
  // Expiry removes the private download, not the integrity of public ID/digest metadata.
  // If GitHub removes that metadata, consumers must fail and use a new CI run.
  return artifact;
}

export function artifactReleaseTag(run) {
  if (!SHA.test(run?.head_sha ?? "") || !id(run.id) || !id(run.run_attempt)) throw new Error("Invalid artifact release identity");
  return `sub2api-ci-${run.head_sha}-${run.id}-${run.run_attempt}`;
}

export function createReleaseReceipt(run, artifacts) {
  return {
    version: 1, repository: REPOSITORY, repositoryId: REPOSITORY_ID,
    revision: run.head_sha, runId: run.id, runAttempt: run.run_attempt, workflowId: run.workflow_id,
    artifacts: ARTIFACT_NAMES.map(name => {
      const matches = artifacts.filter(artifact => artifact.name === name);
      if (matches.length !== 1) throw new Error(`Expected exactly one original ${name} artifact`);
      const artifact = validateArtifact(matches[0], run, name);
      return { name, id: artifact.id, digest: artifact.digest, size: artifact.size_in_bytes, assetName: `${name}.zip` };
    }),
  };
}

export function validateReleaseReceipt(receipt, run, artifacts) {
  const expected = createReleaseReceipt(run, artifacts);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error("Published receipt differs from original GitHub CI provenance");
  return expected;
}
