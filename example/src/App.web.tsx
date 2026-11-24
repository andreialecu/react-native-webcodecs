import React, { useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CompressView } from "./Compress";
import { VideoExportView } from "./VideoExport";
import { colors, Segmented } from "./VideoExport/ui";

// The web build is a one-page demo of the export, not the app's menu: the
// E2E tests and the other screens need the native module.

type Demo = "export" | "compress";
type Mode = "sdr" | "hdr";

const supports = () => {
  const w = globalThis as unknown as {
    VideoEncoder?: unknown;
    matchMedia?: (query: string) => { matches: boolean };
  };
  return {
    webCodecs: typeof w.VideoEncoder === "function",
    webGpu: typeof navigator !== "undefined" && "gpu" in navigator,
    hdrDisplay: !!w.matchMedia?.("(dynamic-range: high)").matches,
  };
};

const note = (hdr: boolean, hdrDisplay: boolean) => {
  if (!hdr) {
    return "Export, then download the MP4.";
  }
  return hdrDisplay
    ? "Your display can show HDR: the preview's lights should look brighter than white."
    : "This display reports no HDR: the preview's lights clip at white, but the file is still HDR.";
};

const LINKS = [
  [
    "WebCodecs",
    "https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API",
  ],
  ["Mediabunny", "https://mediabunny.dev"],
  ["React Native Skia", "https://shopify.github.io/react-native-skia/"],
  ["React Native WebGPU", "https://github.com/wcandillon/react-native-webgpu"],
  ["Nitro Modules", "https://nitro.margelo.com"],
  ["React Native Web", "https://necolas.github.io/react-native-web/"],
] as const;

// react-native-web renders a Text with `href` as a link.
const Link = ({ label, href }: { label: string; href: string }) => (
  <Text
    style={styles.link}
    {...({ href, hrefAttrs: { target: "_blank", rel: "noopener" } } as object)}
  >
    {label}
  </Text>
);

const Check = ({ ok, label }: { ok: boolean; label: string }) => (
  <View style={styles.check}>
    <View
      style={[
        styles.dot,
        { backgroundColor: ok ? colors.accent : colors.error },
      ]}
    />
    <Text style={styles.checkLabel}>{label}</Text>
  </View>
);

const Step = ({
  n,
  title,
  body,
}: {
  n: string;
  title: string;
  body: string;
}) => (
  <View style={styles.step}>
    <Text style={styles.stepNumber}>{n}</Text>
    <View style={styles.stepText}>
      <Text style={styles.stepTitle}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
  </View>
);

function App() {
  const [demo, setDemo] = useState<Demo>("export");
  const [mode, setMode] = useState<Mode>("sdr");
  const { width, height } = useWindowDimensions();
  const wide = width >= 900;
  const support = supports();
  const hdr = mode === "hdr";
  // The phone-sized frame the export screen runs in.
  const frameHeight = Math.max(560, Math.min(820, height - (wide ? 96 : 48)));
  const frameWidth = Math.min(width - 32, Math.round(frameHeight * 0.5));

  return (
    <SafeAreaProvider>
      <ScrollView
        style={styles.page}
        contentContainerStyle={[
          styles.content,
          wide ? styles.contentWide : styles.contentNarrow,
        ]}
      >
        <View style={[styles.intro, wide && styles.introWide]}>
          <Text style={styles.eyebrow}>react-native-webcodecs</Text>
          <Text style={[styles.title, !wide && styles.titleNarrow]}>
            One video pipeline for iOS, Android and the web
          </Text>
          <Text style={styles.lead}>
            The WebCodecs API on VideoToolbox and MediaCodec, so the code that
            exports a video in the browser runs unchanged in a React Native app.
            On this page, the same example app runs with react-native-web, on
            your browser's own WebCodecs.
          </Text>

          <Segmented
            options={[
              { value: "export", label: "Export a Lottie" },
              { value: "compress", label: "Compress a video" },
            ]}
            value={demo}
            onChange={setDemo}
            style={styles.demos}
          />

          {demo === "compress" ? (
            <View style={styles.steps}>
              <Step
                n="1"
                title="Decode"
                body="Pick a video. VideoDecoder reads it with your browser's own decoders. Nothing is uploaded."
              />
              <Step
                n="2"
                title="Scale"
                body="Each frame is drawn at the size you choose, like a messaging app does before sending."
              />
              <Step
                n="3"
                title="Encode"
                body="VideoEncoder, at a bitrate set from the size, frame rate and quality. The sound is copied as is."
              />
              <Step
                n="4"
                title="Mux"
                body="Mediabunny writes the smaller MP4, ready to download."
              />
            </View>
          ) : (
            <View style={styles.steps}>
              <Step
                n="1"
                title="Draw"
                body="A Lottie card, drawn frame by frame by React Native Skia (CanvasKit in the browser)."
              />
              <Step
                n="2"
                title="Encode"
                body={
                  hdr
                    ? "VideoEncoder, VP9 Profile 2, 10-bit, tagged HLG in BT.2020. The lights go up to 1000 nits."
                    : "VideoEncoder, H.264, plus AAC for the sound."
                }
              />
              <Step
                n="3"
                title="Mux"
                body="Mediabunny writes the MP4. Nothing leaves your machine."
              />
            </View>
          )}

          {demo === "export" && (
            <Segmented
              options={[
                { value: "sdr", label: "SDR · H.264" },
                { value: "hdr", label: "HDR · VP9 10-bit" },
              ]}
              value={mode}
              onChange={setMode}
              style={styles.modes}
            />
          )}
          {demo === "export" && (
            <Text style={styles.note}>{note(hdr, support.hdrDisplay)}</Text>
          )}

          <View style={styles.checks}>
            <Check ok={support.webCodecs} label="WebCodecs" />
            <Check ok={support.webGpu} label="WebGPU" />
            <Check ok={support.hdrDisplay} label="HDR display" />
          </View>

          <View style={styles.links}>
            <Text style={styles.credit}>Built with</Text>
            {LINKS.map(([label, href]) => (
              <Link key={label} label={label} href={href} />
            ))}
          </View>
        </View>

        <View
          style={[styles.frame, { width: frameWidth, height: frameHeight }]}
        >
          {demo === "compress" ? (
            <CompressView />
          ) : (
            <VideoExportView key={mode} hdr={hdr} />
          )}
        </View>
      </ScrollView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.background,
    // Web only: a glow behind the content.
    backgroundImage:
      "radial-gradient(ellipse at 70% 10%, rgba(60, 227, 246, 0.12), transparent 55%), radial-gradient(ellipse at 10% 90%, rgba(120, 70, 220, 0.18), transparent 50%)",
  } as object,
  content: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 48,
    padding: 24,
  },
  contentWide: {
    flexDirection: "row",
    paddingVertical: 48,
  },
  contentNarrow: {
    flexDirection: "column",
  },
  intro: {
    maxWidth: 520,
    width: "100%",
    gap: 18,
  },
  introWide: {
    width: 480,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  title: {
    color: colors.text,
    fontSize: 44,
    lineHeight: 50,
    fontWeight: "800",
    letterSpacing: -1,
  },
  titleNarrow: {
    fontSize: 32,
    lineHeight: 38,
  },
  lead: {
    color: colors.textDim,
    fontSize: 17,
    lineHeight: 26,
  },
  steps: {
    gap: 14,
    marginTop: 6,
  },
  step: {
    flexDirection: "row",
    gap: 14,
  },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accentDim,
    color: colors.accent,
    fontWeight: "800",
    fontSize: 13,
    lineHeight: 28,
    textAlign: "center",
  },
  stepText: {
    flex: 1,
    gap: 2,
  },
  stepTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  body: {
    color: colors.textDim,
    fontSize: 14,
    lineHeight: 21,
  },
  demos: {
    marginTop: 24,
    marginBottom: 18,
  },
  modes: {
    marginTop: 8,
  },
  note: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 19,
    minHeight: 38,
  },
  checks: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
  },
  check: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  checkLabel: {
    color: colors.textDim,
    fontSize: 13,
  },
  links: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  credit: {
    color: colors.textDim,
    fontSize: 13,
  },
  link: {
    color: colors.text,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.14)",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
  frame: {
    borderRadius: 36,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    backgroundColor: colors.background,
    boxShadow: "0 30px 80px rgba(0, 0, 0, 0.6)",
  } as object,
});

// eslint-disable-next-line import/no-default-export
export default App;
