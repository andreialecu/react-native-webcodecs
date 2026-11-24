import React, { useCallback, useMemo, useRef, useState } from "react";
import { Platform, StatusBar, StyleSheet, Text, View } from "react-native";
import type { RouteProp } from "@react-navigation/native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDerivedValue } from "react-native-reanimated";
import type { SkSkottieAnimation } from "react-native-skia";
import {
  Canvas,
  Group,
  Skia,
  Skottie,
  useClock,
  useData,
} from "react-native-skia";

import type { Routes } from "../Route";

import card from "./card.json";
import type { Result } from "./export";
import { assetBytes, exportVideo, HEIGHT, shareVideo, WIDTH } from "./export";
import { boostLights } from "./hdr";
import { HdrPreview } from "./HdrPreview";
import { colors, PillButton, RoundButton, Segmented } from "./ui";

// The share card of react-native-skia's Skottie export example, exported
// with react-native-webcodecs (export.ts), or with the browser's WebCodecs on
// the web (export.web.ts).

const json = JSON.stringify(card);
// For HDR, the lights go above SDR white, up to the HLG peak.
const hdrJson = JSON.stringify(boostLights(card));

type Status =
  | { state: "idle" }
  | { state: "exporting"; frames: number; totalFrames: number }
  | { state: "done"; result: Result }
  | { state: "cancelled" }
  | { state: "failed"; message: string };

const Preview = ({
  animation,
  width,
  height,
}: {
  animation: SkSkottieAnimation;
  width: number;
  height: number;
}) => {
  const clock = useClock();
  const frame = useDerivedValue(() => {
    const fps = animation.fps();
    return (
      Math.floor((clock.value / 1000) * fps) % (animation.duration() * fps)
    );
  });
  return (
    <Canvas style={{ width, height }}>
      <Group transform={[{ scale: width / WIDTH }]}>
        <Skottie animation={animation} frame={frame} />
      </Group>
    </Canvas>
  );
};

type Sound = "silent" | "sound";

// The screen in the app's navigation.
export const VideoExport = () => {
  const navigation = useNavigation();
  const route = useRoute<RouteProp<Routes, "VideoExport">>();
  return (
    <VideoExportView
      hdr={route.params?.hdr ?? false}
      onClose={() => navigation.goBack()}
    />
  );
};

// The export screen on its own (the web demo page embeds it). Without
// `onClose`, the close button only cancels.
export const VideoExportView = ({
  hdr,
  onClose,
}: {
  hdr: boolean;
  onClose?: () => void;
}) => {
  const insets = useSafeAreaInsets();
  const photo = useData(require("./assets/photo.jpg"));
  const logo = useData(require("./assets/logo.png"));
  const font = useData(require("./assets/Roboto-Bold.ttf"));
  const [sound, setSound] = useState<Sound>("sound");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const abort = useRef<AbortController | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  // The card fills the space above the controls, at the video's ratio.
  const cardHeight = Math.min(area.height, (area.width * HEIGHT) / WIDTH);
  const cardWidth = (cardHeight * WIDTH) / HEIGHT;

  // One instance for the preview, another for the export: seeking one does
  // not move the other.
  const make = useCallback(
    () =>
      photo && logo && font
        ? Skia.Skottie.Make(hdr ? hdrJson : json, {
            "photo.jpg": photo,
            "logo.png": logo,
            // The animation asks for SF Pro, which can't be redistributed:
            // Roboto stands in.
            SFProBold: font,
          })
        : null,
    [photo, logo, font, hdr],
  );
  const preview = useMemo(make, [make]);

  const run = useCallback(async () => {
    const animation = make();
    if (!animation) {
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setStatus({ state: "exporting", frames: 0, totalFrames: 0 });
    try {
      const bytes =
        sound === "sound"
          ? await assetBytes(require("./assets/sound.m4a"))
          : null;
      const result = await exportVideo(
        animation,
        bytes,
        hdr,
        controller.signal,
        (frames, totalFrames) =>
          setStatus({ state: "exporting", frames, totalFrames }),
      );
      if (result) {
        console.log(
          `[VideoExport] ${result.frames} frames ${WIDTH}x${HEIGHT} in ${result.ms.toFixed(0)} ms: ${result.path}`,
        );
        setStatus({ state: "done", result });
      } else {
        setStatus({ state: "cancelled" });
      }
    } catch (e) {
      setStatus({ state: "failed", message: (e as Error).message });
    } finally {
      abort.current = null;
      animation.dispose?.();
    }
  }, [make, sound, hdr]);

  const share = shareVideo;

  if (!preview) {
    return <View style={styles.container} />;
  }
  const exporting = status.state === "exporting";
  let caption = `${WIDTH} × ${HEIGHT} · ${preview.duration().toFixed(0)} s · ${
    hdr
      ? `${{ web: "VP9", android: "AV1" }[Platform.OS as string] ?? "HEVC"} 10-bit HLG`
      : "H.264"
  }${sound === "sound" ? " + AAC" : ""}`;
  if (status.state === "done") {
    caption = `${status.result.frames} frames exported in ${(
      status.result.ms / 1000
    ).toFixed(1)} s`;
  } else if (status.state === "cancelled") {
    caption = "Export cancelled";
  } else if (status.state === "failed") {
    caption = status.message;
  }
  let pill = (
    <PillButton
      label="Export video"
      icon="export"
      onPress={run}
      testID="export"
    />
  );
  if (exporting) {
    const progress = status.totalFrames
      ? status.frames / status.totalFrames
      : 0;
    pill = (
      <PillButton
        label={`Exporting… ${Math.round(progress * 100)}%`}
        progress={progress}
        onPress={() => {}}
      />
    );
  } else if (status.state === "done") {
    const { path } = status.result;
    pill = (
      <PillButton
        label={Platform.OS === "web" ? "Download video" : "Share video"}
        icon="share"
        onPress={() => share(path)}
        testID="share"
      />
    );
  }
  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 12 },
      ]}
    >
      <StatusBar barStyle="light-content" />
      <View
        style={styles.cardArea}
        onLayout={({ nativeEvent: { layout } }) =>
          setArea({ width: layout.width, height: layout.height })
        }
      >
        {cardHeight > 0 && (
          <View style={[styles.card, { width: cardWidth, height: cardHeight }]}>
            {hdr && Platform.OS !== "android" ? (
              <HdrPreview
                animation={preview}
                width={cardWidth}
                height={cardHeight}
                sourceWidth={WIDTH}
              />
            ) : (
              <Preview
                animation={preview}
                width={cardWidth}
                height={cardHeight}
              />
            )}
          </View>
        )}
      </View>
      <Text
        testID="status"
        numberOfLines={2}
        style={[
          styles.caption,
          status.state === "failed" && { color: colors.error },
        ]}
      >
        {caption}
      </Text>
      <Segmented
        options={[
          { value: "silent", label: "Silent" },
          { value: "sound", label: "With sound" },
        ]}
        value={sound}
        onChange={(value) => {
          setSound(value);
          setStatus({ state: "idle" });
        }}
        disabled={exporting}
        style={styles.segmented}
      />
      <View style={styles.bar}>
        <RoundButton
          icon="close"
          testID={exporting ? "cancel" : "close"}
          onPress={() => (exporting ? abort.current?.abort() : onClose?.())}
          disabled={!exporting && !onClose}
        />
        {pill}
        <RoundButton
          icon="redo"
          onPress={run}
          disabled={status.state !== "done"}
          testID="again"
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 16,
    gap: 14,
  },
  cardArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    borderRadius: 28,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  badge: {
    position: "absolute",
    top: 14,
    right: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: "rgba(6, 4, 14, 0.6)",
  },
  badgeLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
  },
  caption: {
    color: colors.textDim,
    fontSize: 13,
    textAlign: "center",
    minHeight: 18,
  },
  segmented: {
    marginHorizontal: 8,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
});
