# Prompt — add a Scummbar preview workflow to the ScummVM fork

Paste everything below the horizontal rule into a Claude agent running in a
checkout of `rabengraph/scummvm` (e.g. inside `vendor/scummvm-agent/`).

The agent will create a branch, add one workflow file, and open a PR against
`develop`. No changes are made to `rabengraph/scummbar`.

---

I'm working on the ScummVM fork at `rabengraph/scummvm`. I want a GitHub Actions
workflow that triggers a Vercel preview of the **scummbar** harness whenever a
PR here is labeled `scummbar-preview`, and comments the preview URL back on the
PR. This lets me test telemetry bugfixes without modifying scummbar.

**Background:** scummbar's Vercel build (`scripts/vercel-build.sh` →
`scripts/build-scummvm.sh`) already reads an env var `SCUMMVM_AGENT_BRANCH` and
checks out that branch of `rabengraph/scummvm` before building. So the workflow
just needs to upload scummbar `main` to Vercel with that env var overridden to
the current PR's head ref. No changes to scummbar are needed.

## Task

1. Create a new branch off `develop` (e.g. `ci/scummbar-preview`).
2. Add the workflow file below at `.github/workflows/scummbar-preview.yml`.
3. Open a PR against `develop` titled "CI: Scummbar preview on labeled PRs".
4. In the PR description, list the three repo secrets the user must add (see
   the "Secrets required" section below) and note they're not set until the
   user adds them via GitHub Settings.
5. Do NOT try to add the label or test-deploy yourself — that requires the
   secrets to be set first.

## Workflow file

Path: `.github/workflows/scummbar-preview.yml`

```yaml
name: Scummbar Preview

on:
  pull_request:
    types: [labeled, unlabeled, synchronize]

concurrency:
  group: scummbar-preview-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  pull-requests: write
  contents: read

env:
  PREVIEW_LABEL: scummbar-preview
  SCUMMBAR_REPO: rabengraph/scummbar
  SCUMMBAR_REF: main

jobs:
  dismiss:
    if: >
      github.event.action == 'unlabeled'
      && github.event.label.name == 'scummbar-preview'
    runs-on: ubuntu-latest
    steps:
      - name: Sticky comment — preview dismissed
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: scummbar-preview
          message: |
            Scummbar preview dismissed — label `scummbar-preview` removed.
            (The last deployment URL stays live on Vercel until it ages out.)

  deploy:
    if: >
      (github.event.action == 'labeled'
        && github.event.label.name == 'scummbar-preview')
      || (github.event.action == 'synchronize'
        && contains(github.event.pull_request.labels.*.name, 'scummbar-preview'))
    runs-on: ubuntu-latest
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
      FORK_BRANCH: ${{ github.event.pull_request.head.ref }}
      FORK_SHA: ${{ github.event.pull_request.head.sha }}
    steps:
      - name: Sticky comment — building
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: scummbar-preview
          message: |
            Scummbar preview building for fork commit `${{ env.FORK_SHA }}`…
            Follow progress: [workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})

      - name: Checkout scummbar main
        uses: actions/checkout@v4
        with:
          repository: ${{ env.SCUMMBAR_REPO }}
          ref: ${{ env.SCUMMBAR_REF }}

      - name: Install Vercel CLI
        run: npm i -g vercel@latest

      - name: Pull Vercel project settings
        run: vercel pull --yes --environment=preview --token="$VERCEL_TOKEN"

      - name: Deploy preview
        id: deploy
        run: |
          set -euo pipefail
          URL=$(vercel deploy \
            --build-env SCUMMVM_AGENT_BRANCH="$FORK_BRANCH" \
            --token="$VERCEL_TOKEN" \
            --yes)
          echo "Preview URL: $URL"
          echo "url=$URL" >> "$GITHUB_OUTPUT"

      - name: Sticky comment — preview ready
        if: success()
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: scummbar-preview
          message: |
            Scummbar preview: ${{ steps.deploy.outputs.url }}

            - scummbar ref: `${{ env.SCUMMBAR_REPO }}@${{ env.SCUMMBAR_REF }}`
            - scummvm branch: `${{ env.FORK_BRANCH }}` @ `${{ env.FORK_SHA }}`

      - name: Sticky comment — deploy failed
        if: failure()
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: scummbar-preview
          message: |
            Scummbar preview failed for fork commit `${{ env.FORK_SHA }}`.
            See the [workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}).
```

## Secrets required (put in the PR description)

Three repo secrets must exist on `rabengraph/scummvm` before the workflow will
succeed. The user sets these in **GitHub → Settings → Secrets and variables →
Actions**:

- `VERCEL_TOKEN` — create at https://vercel.com/account/tokens (needs deploy
  rights on the scummbar project).
- `VERCEL_ORG_ID` — from scummbar's `.vercel/project.json`. Get it by running
  `vercel link` locally in a scummbar checkout, then `cat .vercel/project.json`.
- `VERCEL_PROJECT_ID` — same source as above.

## Test plan (for the user, after secrets are added)

1. Open a PR on `rabengraph/scummvm` (any change — a README tweak is fine).
2. Apply the `scummbar-preview` label (create the label first if it doesn't
   exist; any color).
3. The workflow should start, comment "building…", then update that same
   comment with the preview URL.
4. Visit the URL, add `?game=monkey1` (if you've pre-staged a game) or use the
   upload UI, verify telemetry reflects the PR's changes.
5. Push another commit to the PR — the preview should rebuild and the comment
   should update.
6. Remove the label — expect a "preview dismissed" comment.

## Caveats to mention in the PR description

- Only works for PRs opened from branches inside `rabengraph/scummvm` itself
  (not from contributor forks). The `pull_request` event doesn't expose secrets
  to third-party-fork PRs. Not needed for current workflow; can switch to
  `pull_request_target` later if that changes.
- Each build takes ~5–10 minutes (emsdk install + ScummVM compile). Concurrency
  cancels older runs on a PR when new commits land.
- The preview URL persists on Vercel after the label is removed; cleanup is
  manual if that matters.
