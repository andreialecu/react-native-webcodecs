import { native } from "./native";

/**
 * Runs `fn` with the app kept alive in the background (iOS: a UIApplication
 * background task, a few seconds to minutes as iOS decides), for the end of
 * an export the user may leave: `withBackgroundTask(() => output.finalize())`.
 * While a task is held, encoders do not fail with `interrupted` when the app
 * goes to the background. Nothing to do on Android.
 */
export const withBackgroundTask = async <T>(
  fn: () => Promise<T>,
  name = "react-native-webcodecs",
): Promise<T> => {
  const id = native().beginBackgroundTask(name);
  try {
    return await fn();
  } finally {
    native().endBackgroundTask(id);
  }
};
