// Skip stale CI completions and manual feature-branch runs before any production write.
import { appendFile } from "node:fs/promises";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const revision = process.env.CHECKED_SHA ?? "";
const token = process.env.GITHUB_TOKEN ?? "";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(revision) || token === "") throw new Error("GitHub repository, token and verified revision are required");
const response = await fetch(`https://api.github.com/repos/${repository}/commits/main`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(30_000) });
const body = await response.json().catch(() => null);
if (!response.ok || typeof body?.sha !== "string") throw new Error(`Could not verify the current main revision (HTTP ${response.status})`);
const current = body.sha === revision;
if (!current) console.log("::notice::Skipping deployment: the verified revision is not the current main revision.");
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `current=${current}\n`);
else if (!current) process.exitCode = 1;
