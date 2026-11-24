import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  colors,
  Icon,
  PillButton,
  RoundButton,
  Segmented,
} from "../VideoExport/ui";

import { supportedCodecs } from "./codecs";
import { compress, openSource, shareResult } from "./compress";
import { pickVideo } from "./pick";
import type {
  Codec,
  QualityLevel,
  Resolution,
  Result,
  Settings,
  Source,
} from "./settings";
import {
  CODEC_NAMES,
  estimatedSize,
  formatBitrate,
  formatBytes,
  formatDuration,
  targetSize,
  videoBitrate,
} from "./settings";

// Compresses a video from the library, as a messaging app does before
// sending it: smaller, at a lower bitrate, with its sound copied as is.

type Status =
  | { state: "idle" }
  | { state: "opening" }
  | { state: "compressing"; progress: number }
  | { state: "done"; result: Result }
  | { state: "cancelled" }
  | { state: "failed"; message: string };

const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
];

const QUALITIES: { value: QualityLevel; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const Row = ({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children: React.ReactNode;
}) => (
  <View style={styles.row}>
    <View style={styles.rowHeader}>
      <Text style={styles.rowLabel}>{label}</Text>
      {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
    </View>
    {children}
  </View>
);

const Chip = ({ text }: { text: string }) => (
  <View style={styles.chip}>
    <Text style={styles.chipText}>{text}</Text>
  </View>
);

const statusLine = (
  status: Status,
  output: { width: number; height: number },
  codec: Codec,
  settings: Settings,
) => {
  if (status.state === "failed") {
    return status.message;
  }
  if (status.state === "cancelled") {
    return "Cancelled";
  }
  return `${output.width}×${output.height} · ${CODEC_NAMES[codec]} · ${formatBitrate(settings.videoBitrate)}`;
};

const codecLabel = (codec: string) =>
  CODEC_NAMES[codec as Codec] ?? codec.toUpperCase();

export const CompressView = ({ onClose }: { onClose?: () => void }) => {
  const insets = useSafeAreaInsets();
  const [source, setSource] = useState<Source | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [resolution, setResolution] = useState<Resolution>("720");
  const [quality, setQuality] = useState<QualityLevel>("medium");
  const [codec, setCodec] = useState<Codec>("avc");
  const [codecs, setCodecs] = useState<Codec[]>(["avc"]);
  const [frameRate, setFrameRate] = useState<"source" | "30" | "24">("source");
  const [audio, setAudio] = useState<"keep" | "remove">("keep");
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);

  const busy = status.state === "compressing" || status.state === "opening";
  const output = source ? targetSize(source, resolution) : null;

  // The codecs the device encodes at the output size.
  useEffect(() => {
    if (!output) {
      return;
    }
    let live = true;
    supportedCodecs(output.width, output.height).then((list) => {
      if (live && list.length) {
        setCodecs(list);
        setCodec((current) => (list.includes(current) ? current : list[0]));
      }
    });
    return () => {
      live = false;
    };
  }, [output?.width, output?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keeps the summary, where progress and the result show, in view.
  useEffect(() => {
    if (status.state !== "idle" && status.state !== "opening") {
      scroll.current?.scrollToEnd({ animated: true });
    }
  }, [status.state]);

  const settings: Settings | null = useMemo(() => {
    if (!source) {
      return null;
    }
    const fps = frameRate === "source" ? null : Number(frameRate);
    return {
      resolution,
      quality,
      codec,
      frameRate: fps,
      audio: audio === "keep",
      videoBitrate: videoBitrate(source, resolution, quality, codec, fps),
    };
  }, [source, resolution, quality, codec, frameRate, audio]);

  const choose = async () => {
    try {
      const picked = await pickVideo();
      if (!picked) {
        return;
      }
      setStatus({ state: "opening" });
      const opened = await openSource(picked);
      setSource(opened);
      // Default to 720p, or the source's own size when it is smaller.
      setResolution(
        Math.min(opened.width, opened.height) > 720 ? "720" : "original",
      );
      setStatus({ state: "idle" });
    } catch (e) {
      setStatus({ state: "failed", message: (e as Error).message });
    }
  };

  const run = async () => {
    if (!source || !settings) {
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setStatus({ state: "compressing", progress: 0 });
    try {
      const result = await compress(source, settings, controller.signal, (p) =>
        setStatus({ state: "compressing", progress: p }),
      );
      setStatus(result ? { state: "done", result } : { state: "cancelled" });
    } catch (e) {
      setStatus({ state: "failed", message: (e as Error).message });
    } finally {
      abort.current = null;
    }
  };

  // Settings changed after a result: the result no longer matches them.
  const change =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      if (status.state === "done" || status.state === "cancelled") {
        setStatus({ state: "idle" });
      }
    };

  const estimate = source && settings ? estimatedSize(source, settings) : 0;
  const shorter = source ? Math.min(source.width, source.height) : 0;
  const resolutions = RESOLUTIONS.filter(
    (r) => r.value === "original" || Number(r.value) < shorter,
  );

  let pill = (
    <PillButton
      label={source ? "Compress" : "Choose a video"}
      icon={source ? "compress" : "video"}
      onPress={source ? run : choose}
      disabled={status.state === "opening"}
      testID="compress"
    />
  );
  if (status.state === "compressing") {
    pill = (
      <PillButton
        label={`Compressing… ${Math.round(status.progress * 100)}%`}
        progress={status.progress}
        onPress={() => {}}
      />
    );
  } else if (status.state === "done" && source) {
    const { result } = status;
    pill = (
      <PillButton
        label={Platform.OS === "web" ? "Download" : "Share"}
        icon="share"
        onPress={() => shareResult(result, source.name)}
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
      <ScrollView
        ref={scroll}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Compress a video</Text>
        <Text style={styles.subtitle}>
          Smaller and ready to send, the way a messaging app does it: decoded
          and encoded on the device's own codecs, scaled on the GPU, sound
          copied as is.
        </Text>

        {source ? (
          <Pressable
            style={styles.card}
            onPress={busy ? undefined : choose}
            testID="source"
          >
            <View style={styles.cardHeader}>
              <Text style={styles.cardLabel}>Source</Text>
              {!busy && <Text style={styles.cardAction}>Change</Text>}
            </View>
            <Text style={styles.fileName} numberOfLines={1}>
              {source.name}
            </Text>
            <View style={styles.chips}>
              <Chip text={formatBytes(source.size)} />
              <Chip text={`${source.width}×${source.height}`} />
              <Chip text={codecLabel(source.codec)} />
              <Chip text={formatDuration(source.duration)} />
              <Chip text={formatBitrate(source.bitrate)} />
              {source.frameRate > 0 && (
                <Chip text={`${Math.round(source.frameRate)} fps`} />
              )}
              <Chip
                text={
                  source.audio
                    ? `${codecLabel(source.audio.codec)} audio`
                    : "No audio"
                }
              />
            </View>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.card, styles.empty]}
            onPress={choose}
            disabled={busy}
            testID="choose"
          >
            <Icon name="video" color={colors.accent} size={36} />
            <Text style={styles.emptyTitle}>
              {status.state === "opening" ? "Opening…" : "Choose a video"}
            </Text>
            <Text style={styles.emptyText}>
              From your library. A phone recording works best.
            </Text>
          </Pressable>
        )}

        {source && settings && output && (
          <>
            <View style={styles.card}>
              <Row
                label="Resolution"
                detail={`${output.width}×${output.height}`}
              >
                <Segmented
                  options={resolutions}
                  value={resolution}
                  onChange={change(setResolution)}
                  disabled={busy}
                />
              </Row>
              <Row
                label="Quality"
                detail={formatBitrate(settings.videoBitrate)}
              >
                <Segmented
                  options={QUALITIES}
                  value={quality}
                  onChange={change(setQuality)}
                  disabled={busy}
                />
              </Row>
              <Row label="Codec" detail="What this device can encode">
                <Segmented
                  options={codecs.map((c) => ({
                    value: c,
                    label: CODEC_NAMES[c],
                  }))}
                  value={codec}
                  onChange={change(setCodec)}
                  disabled={busy}
                />
              </Row>
              <Row label="Frame rate">
                <Segmented
                  options={[
                    {
                      value: "source",
                      label: source.frameRate
                        ? `Original (${Math.round(source.frameRate)})`
                        : "Original",
                    },
                    { value: "30", label: "30" },
                    { value: "24", label: "24" },
                  ]}
                  value={frameRate}
                  onChange={change(setFrameRate)}
                  disabled={busy}
                />
              </Row>
              <Row
                label="Sound"
                detail={
                  source.audio ? "Copied, not re-encoded" : "None in the source"
                }
              >
                <Segmented
                  options={[
                    { value: "keep", label: "Keep" },
                    { value: "remove", label: "Remove" },
                  ]}
                  value={source.audio ? audio : "remove"}
                  onChange={change(setAudio)}
                  disabled={busy || !source.audio}
                />
              </Row>
            </View>

            <View style={[styles.card, styles.summary]}>
              {status.state === "done" ? (
                <>
                  <Text style={styles.cardLabel}>Done</Text>
                  <Text style={styles.big}>
                    {formatBytes(status.result.size)}
                  </Text>
                  <Text style={styles.saving}>
                    {Math.max(
                      0,
                      Math.round((1 - status.result.size / source.size) * 100),
                    )}
                    % smaller than {formatBytes(source.size)}
                  </Text>
                  <Text style={styles.meta}>
                    {status.result.width}×{status.result.height} ·{" "}
                    {CODEC_NAMES[codec]} · in{" "}
                    {(status.result.ms / 1000).toFixed(1)} s (
                    {(source.duration / (status.result.ms / 1000)).toFixed(1)}×
                    real time)
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.cardLabel}>Estimated size</Text>
                  <Text style={styles.big}>≈ {formatBytes(estimate)}</Text>
                  <Text style={styles.saving}>
                    {Math.max(
                      0,
                      Math.round((1 - estimate / source.size) * 100),
                    )}
                    % smaller than {formatBytes(source.size)}
                  </Text>
                  <Text
                    style={[
                      styles.meta,
                      status.state === "failed" && { color: colors.error },
                    ]}
                    testID="status"
                  >
                    {statusLine(status, output, codec, settings)}
                  </Text>
                </>
              )}
            </View>
          </>
        )}
        {!source && status.state === "failed" && (
          <Text style={[styles.meta, { color: colors.error }]}>
            {status.message}
          </Text>
        )}
      </ScrollView>

      <View style={styles.bar}>
        <RoundButton
          icon="close"
          testID={busy ? "cancel" : "close"}
          onPress={() => (busy ? abort.current?.abort() : onClose?.())}
          disabled={!busy && !onClose}
        />
        {pill}
        <RoundButton
          icon="redo"
          onPress={status.state === "done" ? run : choose}
          disabled={busy || !source}
          testID="again"
        />
      </View>
    </View>
  );
};

// The screen in the app's navigation.
export const Compress = () => {
  const navigation = useNavigation();
  return <CompressView onClose={() => navigation.goBack()} />;
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 16,
    gap: 12,
  },
  scroll: {
    flex: 1,
  },
  content: {
    gap: 14,
    paddingBottom: 8,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.5,
    marginTop: 8,
  },
  subtitle: {
    color: colors.textDim,
    fontSize: 14,
    lineHeight: 20,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 16,
    gap: 12,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardLabel: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  cardAction: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
  fileName: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.surfaceRaised,
  },
  chipText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  empty: {
    alignItems: "center",
    paddingVertical: 36,
    borderStyle: "dashed",
    borderWidth: 1.5,
    borderColor: "rgba(60, 227, 246, 0.35)",
    gap: 8,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  emptyText: {
    color: colors.textDim,
    fontSize: 13,
  },
  row: {
    gap: 8,
  },
  rowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  rowLabel: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  rowDetail: {
    color: colors.textDim,
    fontSize: 13,
  },
  summary: {
    alignItems: "center",
    gap: 4,
  },
  big: {
    color: colors.text,
    fontSize: 40,
    fontWeight: "800",
    letterSpacing: -1,
  },
  saving: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "700",
  },
  meta: {
    color: colors.textDim,
    fontSize: 13,
    textAlign: "center",
    marginTop: 4,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
});
