# Lysterfield Lake app

The app that plays [Lysterfield Lake](https://lysterfieldlake.com/). See the [root README](../../README.md) for how the project fits together.

## Commands

Run these from the repo root with `bun run --cwd apps/client <script>`.

| Script | What it does |
| --- | --- |
| `dev` | Runs Vite. `/admin`, the dream and polaroid tools, only exists here. |
| `dev-external` | Runs Vite on your network, for testing tilt on a phone. |
| `generate` | Writes `src/dreams.json` from the `dreams/` folder. |
| `build-next` | Builds the site for lysterfieldlake.com. |
| `deploy-next` | Builds and deploys the Worker by hand. Merging to `main` does the same. |
| `test` | Runs the tests with Vitest. |
| `lint` | Runs ESLint. |
