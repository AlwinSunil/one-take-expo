# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

Live captions use a local Kotlin module with the verified Moonshine Tiny Streaming runtime.
See [live caption setup and verification](docs/live-captions.md) before building Android.

### Android Studio and a physical Android phone

Use Node.js 22.13 or newer for [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/).
Install dependencies with `npm ci` before opening the native project.

1. In Android Studio's SDK Manager, install Android SDK Platform 36, Build Tools 36.0.0, Platform Tools, NDK (Side by side) 27.1.12297006, and CMake 3.22.1.
   Enable **Show Package Details** to select the exact NDK version.
2. Open this repository's `android/` directory in Android Studio and let Gradle sync finish.
   Use the Gradle wrapper provided by the project.
   Android Studio creates `android/local.properties` with your local SDK path; this machine-specific file is intentionally ignored by Git.
3. Enable USB debugging on your phone, connect it with a data-capable USB cable, and accept the phone's debugging authorization prompt.
   Confirm it appears as `device` in `adb devices -l`.
4. From the repository root, run `npm run android -- --device` and select the connected phone.
   This builds and installs the native app and starts Metro.

To use Android Studio's Run button, keep `npm start -- --localhost` running in a terminal at the repository root, run `adb reverse tcp:8081 tcp:8081`, and select the `app` configuration and your phone in Studio.
If several devices are connected, pass `-s <serial>` to `adb`.
Keep Metro running while using the debug app.

On macOS, the default SDK path is `~/Library/Android/sdk`.
If terminal tools cannot find it, set `ANDROID_HOME` to that path and add `$ANDROID_HOME/platform-tools` to your `PATH`.
Set `JAVA_HOME` to an installed JDK or Android Studio's bundled runtime if Java cannot be found.

If the build reports `[CXX1101]` and a missing NDK `source.properties`, the local NDK installation is incomplete.
Stop builds and Gradle sync, move the incomplete version directory outside the SDK's `ndk/` folder, then reinstall that exact version through SDK Manager before retrying.
Do not change the project's NDK version to work around a partial download.
The tracked `android/gradlew` must remain executable; `chmod +x android/gradlew` repairs checkouts that lost that permission.

### Expo development server

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.

### Development sample sessions

Debug builds expose **Sample sessions · Dev** on Home, with seven in-memory examples and device-run handoff, storage and coaching checks. Samples never enter Projects; the separate storage checks create and clean up dedicated fixture projects. **Playback & export research · Dev** runs the native media experiment. See [setup and expected states](docs/development/sample-sessions.md), [research status](docs/development/milestone-0-status.md) and the [Milestone 1 handoff](docs/development/milestone-1-handoff.md).
