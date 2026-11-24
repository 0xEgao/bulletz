import type { Event } from "./index.js";

export const GITHUB_BOT_HANDLE = "github[bot]";

export function isGitHubMessage(event: Event): boolean {
  return event.actor_kind === "integration" && event.actor_handle === GITHUB_BOT_HANDLE &&
    event.kind === "message" && event.payload.source === "github";
}

export function isGitHubOrganization(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(name);
}

export const GITHUB_EVENTS = {
  pull_requests: "Pull requests and reviews",
  issues: "Issues and comments",
  releases: "Releases",
  ci_failures: "Failed workflow runs",
  deployments: "Deployments",
  pushes: "Pushes",
  organization: "Organization, team, and repository changes",
  other: "Other events",
} as const;

export type GitHubCategory = keyof typeof GITHUB_EVENTS;
export const DEFAULT_GITHUB_EVENTS: readonly GitHubCategory[] = ["pull_requests", "issues", "releases", "ci_failures"];
export const MAX_GITHUB_ROUTES = 20;

export type GitHubRoute = {
  channel_id: string;
  events: GitHubCategory[];
  repositories: string[];
};

export type GitHubConnection = {
  organization: string;
  webhook_url: string;
  secret: string;
  routes: GitHubRoute[];
  last_delivery_at: string | null;
  last_posted_at: string | null;
};

export function githubLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
