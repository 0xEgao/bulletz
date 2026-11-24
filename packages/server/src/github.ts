import { createHmac, timingSafeEqual } from "node:crypto";
import { githubLink, type GitHubCategory } from "@bulletz/shared";

export function verifyGitHubSignature(secret: string, body: Buffer, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

type Payload = Record<string, unknown>;

export function payloadObject(value: unknown): Payload {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Payload : {};
}

function plain(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, 250).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ").trim()
    : "";
}

const CATEGORIES: Readonly<Record<string, GitHubCategory>> = {
  pull_request: "pull_requests",
  pull_request_review: "pull_requests",
  pull_request_review_comment: "pull_requests",
  pull_request_review_thread: "pull_requests",
  issues: "issues",
  issue_comment: "issues",
  release: "releases",
  workflow_run: "ci_failures",
  deployment: "deployments",
  deployment_status: "deployments",
  push: "pushes",
  organization: "organization",
  membership: "organization",
  team: "organization",
  team_add: "organization",
  repository: "organization",
};

const ENTITY: Readonly<Record<string, string>> = {
  pull_request: "Pull request",
  pull_request_review: "Pull request review",
  pull_request_review_comment: "Pull request review comment",
  pull_request_review_thread: "Pull request review thread",
  issues: "Issue",
  issue_comment: "Comment",
  release: "Release",
  workflow_run: "Workflow",
  deployment: "Deployment",
  deployment_status: "Deployment",
};

const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure", "stale"]);

export function formatGitHubEvent(event: string, payload: Payload, organization: string) {
  const repo = payloadObject(payload.repository);
  const repository = plain(repo.name);
  const context = repository ? `${organization}/${repository}` : organization;
  const fallbackUrl = `https://github.com/${encodeURIComponent(organization)}` +
    (repository ? `/${encodeURIComponent(repository)}` : "");
  const sender = plain(payloadObject(payload.sender).login);
  const author = sender ? ` · ${sender}` : "";
  const action = plain(payload.action);
  const pr = payloadObject(payload.pull_request);
  const issue = payloadObject(payload.issue);
  const release = payloadObject(payload.release);
  const workflow = payloadObject(payload.workflow_run);
  const deployment = payloadObject(payload.deployment);
  const deploymentStatus = payloadObject(payload.deployment_status);
  const review = payloadObject(payload.review);
  const comment = payloadObject(payload.comment);

  let category = Object.hasOwn(CATEGORIES, event) ? CATEGORIES[event]! : "other";
  let label = Object.hasOwn(ENTITY, event) ? ENTITY[event]! : event.replaceAll("_", " ");
  let state = action.replaceAll("_", " ");
  let subject = "";
  let url: unknown = repo.html_url;

  switch (event) {
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment":
    case "pull_request_review_thread":
      if (action === "closed" && pr.merged === true) state = "merged";
      if (event === "pull_request_review" && action === "submitted") {
        state = plain(review.state).replaceAll("_", " ") || state;
      }
      subject = [typeof pr.number === "number" ? `#${pr.number}` : "", plain(pr.title)].filter(Boolean).join(" ");
      url = comment.html_url ?? review.html_url ?? pr.html_url;
      break;
    case "issues":
    case "issue_comment":
      if (issue.pull_request) {
        category = "pull_requests";
        label = "Pull request comment";
      }
      subject = [typeof issue.number === "number" ? `#${issue.number}` : "", plain(issue.title)].filter(Boolean).join(" ");
      url = comment.html_url ?? issue.html_url;
      break;
    case "release":
      subject = plain(release.name) || plain(release.tag_name);
      url = release.html_url;
      break;
    case "workflow_run": {
      const conclusion = plain(workflow.conclusion);
      if (action !== "completed" || !FAILED.has(conclusion)) return null;
      state = conclusion.replaceAll("_", " ");
      subject = plain(workflow.name);
      url = workflow.html_url;
      break;
    }
    case "deployment":
    case "deployment_status":
      state = plain(deploymentStatus.state) || "created";
      subject = plain(deployment.environment);
      break;
    case "push":
      label = payload.deleted === true ? "Deleted ref" : "Push";
      subject = plain(payload.ref).replace(/^refs\/(heads|tags)\//, "");
      url = payload.compare;
      break;
    case "organization":
    case "membership":
    case "team":
    case "team_add":
      subject = plain(payloadObject(payload.team).name) || plain(payloadObject(payload.membership).user
        ? payloadObject(payloadObject(payload.membership).user).login
        : payloadObject(payload.member).login);
      break;
  }

  return {
    category,
    repository: repository.toLowerCase(),
    body: [`[${context}] ${label}`, state, subject ? `— ${subject}` : ""].filter(Boolean).join(" ") + author,
    url: githubLink(url) ?? fallbackUrl,
  };
}
