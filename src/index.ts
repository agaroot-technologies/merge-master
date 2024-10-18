import * as core from '@actions/core';
import * as github from '@actions/github';

import type { PullRequest as PullRequestTypedef } from '@octokit/graphql-schema';

type PullRequest = Omit<PullRequestTypedef, 'labels'> & {
  id: PullRequestTypedef['id'];
  title: PullRequestTypedef['title'];
  author: NonNullable<PullRequestTypedef['author']>;
  labels: { nodes: { name: string }[] };
  number: PullRequestTypedef['number'];
  isDraft: PullRequestTypedef['isDraft'];
  mergeStateStatus: PullRequestTypedef['mergeStateStatus'];
  mergeable: PullRequestTypedef['mergeable'];
  autoMergeRequest: NonNullable<PullRequestTypedef['autoMergeRequest']>;
  statusCheckRollup: NonNullable<PullRequestTypedef['statusCheckRollup']>;
};

type GraphqlResponse = {
  repository: {
    pullRequests: {
      nodes: PullRequest[];
    };
  };
};

const run = async (): Promise<void> => {
  try {
    const token = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);

    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    const query = `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          pullRequests(baseRefName: "main", first: 100, states: OPEN, orderBy: { field: CREATED_AT, direction: ASC }) {
            nodes {
              id
              title
              author { login }
              labels(first: 100) { nodes { name } }
              number
              isDraft
              mergeStateStatus
              mergeable
              autoMergeRequest { enabledAt }
              statusCheckRollup { state }
            }
          }
        }
      }
    `;

    const targetPRs: PullRequest[] = await octokit.graphql<GraphqlResponse>(query, { owner, repo })
      .then((resp) =>
        resp.repository.pullRequests.nodes.filter((pr) =>
          [
            pr.autoMergeRequest,
            pr.mergeable === 'MERGEABLE' || (pr.author.login === 'renovate' && pr.mergeable === 'CONFLICTING'),
            pr.statusCheckRollup && pr.statusCheckRollup.state !== 'FAILURE',
            !pr.isDraft,
          ].every(Boolean),
        ),
      );

    if (targetPRs.length === 0) {
      core.info('No PRs to update');
      return;
    }

    if (targetPRs.some((pr) => pr.statusCheckRollup.state === 'PENDING' && pr.mergeStateStatus !== 'BEHIND')) {
      core.info('There is a PR that is following the base branch and CI is running');
      return;
    }

    const targetPR = targetPRs.find((pr) => pr.author.login !== 'renovate') || targetPRs[0]!;

    if (targetPR.author.login === 'renovate') {
      core.info(`Rebase Renovate PR: ${targetPR.number}`);
      if (targetPR.labels.nodes.some(({ name }) => name === 'rebase')) {
        core.info('This PR is already rebasing by Renovate');
        return;
      }
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: targetPR.number,
        labels: ['rebase'],
      });
    } else {
      core.info(`Update branch of PR: ${targetPR.number}`);
      await octokit.rest.pulls.updateBranch({
        owner,
        repo,
        pull_number: targetPR.number,
      });
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
};

void run();
