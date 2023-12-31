# Lysterfield Lake (App)

Client for the Lysterfield Lake project.

🚨 **Please note:** 🚨 This was a passion project, provided purely as a resource for anyone looking to dive into aspects of how [Lysterfield Lake](https://lysterfieldlake.com/) was created. It is not a great representation of how to build a performant React app (or at least, I'm pretty sure it isn't).

> The pipeline for generating the visuals is available at [superhighfives/lysterfield-lake-pipeline](https://github.com/superhighfives/lysterfield-lake-pipeline)

✋ You can [learn more about how the project works here](https://medium.com/@superhighfives/lysterfield-lake-71345aa8c016).

<a href="https://medium.com/@superhighfives/lysterfield-lake-71345aa8c016">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/superhighfives/lysterfield-lake/assets/449385/36e1b0ab-c7f1-4450-992a-681b254ee1ea">
    <img src="https://github.com/superhighfives/lysterfield-lake/assets/449385/4c14e91a-26bc-4f92-9301-7b0f12dc79de">
  </picture>
</a>

## Getting started

You'll need to get the video files. These are available here:
https://drive.google.com/drive/folders/15I4ll5xXZZM9p2RhYRrsui7UqELMy4YG?usp=drive_link

Place them in the `dreams/` folder, so they should look like `dreams/20230808103741`, etc.

You'll also need to run `npm install`.

## Development

### `npm run dev`
Runs vite.

### `npm run dev-external`
Runs vite, allowing access on the network (important for testing accelerometer features, which require a https server to be running locally).

### `build`
Builds the app.

### `generate`
Generates the json file required for the dreams.

### `deploy`
Builds and deploys using rclone. You will need a `r2:lysterfield-lake` remote set up in your rclone config.
