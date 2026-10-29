/** K-801, K-1127: the workflow that deploys a repo with kitshn, as "Add a site" shows it and `kitshn repo` writes it. */
export const deployWorkflow = (server: string) => `name: kitshn
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  kitshn:
    uses: Yarden-zamir/kitshn/.github/workflows/kitshn2-deploy.yml@main
    with:
      server: ${server}`;
