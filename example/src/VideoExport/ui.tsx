import React from "react";
import type { ViewStyle } from "react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Canvas, Path } from "react-native-skia";

// The colors of the animation: its cyan accent on its night-purple ground.
export const colors = {
  background: "#06040E",
  surface: "#120C22",
  surfaceRaised: "#221837",
  border: "rgba(255, 255, 255, 0.07)",
  accent: "#3CE3F6",
  accentDim: "#0F3D47",
  onAccent: "#04161B",
  text: "#FFFFFF",
  textDim: "rgba(255, 255, 255, 0.55)",
  error: "#FF6B81",
};

// 24×24 stroked icons.
const icons = {
  close: "M6 6 L18 18 M18 6 L6 18",
  share: "M12 3 L12 15 M7 8 L12 3 L17 8 M5 12 L5 20 L19 20 L19 12",
  export: "M12 4 L12 16 M7 11 L12 16 L17 11 M5 20 L19 20",
  redo: "M20 12 A8 8 0 1 1 17.66 6.34 M20 4 L20 9 L15 9",
  // Two arrows pointing in: make smaller.
  compress: "M4 4 L10 10 M10 5 L10 10 L5 10 M20 20 L14 14 M14 19 L14 14 L19 14",
  // A four-pointed sparkle.
  sparkle:
    "M12 3 L13.8 10.2 L21 12 L13.8 13.8 L12 21 L10.2 13.8 L3 12 L10.2 10.2 Z",
  // A film frame with a plus.
  video:
    "M4 6 L15 6 L15 18 L4 18 Z M15 10 L20 7 L20 17 L15 14 M9.5 9.5 L9.5 14.5 M7 12 L12 12",
};

export const Icon = ({
  name,
  color,
  size = 20,
}: {
  name: keyof typeof icons;
  color: string;
  size?: number;
}) => {
  const path = icons[name];
  return (
    <Canvas style={{ width: size, height: size }}>
      <Path
        path={path}
        color={color}
        style="stroke"
        strokeWidth={2.2}
        strokeCap="round"
        strokeJoin="round"
        transform={[{ scale: size / 24 }]}
      />
    </Canvas>
  );
};

export const RoundButton = ({
  icon,
  onPress,
  disabled,
  testID,
}: {
  icon: keyof typeof icons;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    testID={testID}
    style={({ pressed }) => [
      styles.round,
      pressed && { opacity: 0.7 },
      disabled && { opacity: 0.35 },
    ]}
  >
    <Icon name={icon} color={colors.text} />
  </Pressable>
);

// The main action: a pill that fills up with the export's progress.
export const PillButton = ({
  label,
  icon,
  onPress,
  progress,
  disabled,
  testID,
}: {
  label: string;
  icon?: keyof typeof icons;
  onPress: () => void;
  // 0 to 1 while busy: the pill is drawn as a progress bar.
  progress?: number;
  disabled?: boolean;
  testID?: string;
}) => {
  const busy = progress !== undefined;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      testID={testID}
      style={({ pressed }) => [
        styles.pill,
        busy && { backgroundColor: colors.accentDim },
        { opacity: pressed ? 0.85 : 1 },
      ]}
    >
      {busy && (
        <View
          style={[
            StyleSheet.absoluteFill,
            styles.pillFill,
            { width: `${Math.round(progress * 100)}%` },
          ]}
        />
      )}
      {icon && !busy && <Icon name={icon} color={colors.onAccent} size={18} />}
      <Text style={styles.pillLabel}>{label}</Text>
    </Pressable>
  );
};

// `accent` fills the selected option with the accent color, for a switch
// that has to stand out (the web page's choice of demo).
export const Segmented = <T extends string>({
  options,
  value,
  onChange,
  disabled,
  style,
  accent,
}: {
  options: { value: T; label: string; icon?: keyof typeof icons }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  style?: ViewStyle;
  accent?: boolean;
}) => (
  <View
    style={[
      styles.segmented,
      accent && styles.segmentedAccent,
      disabled && { opacity: 0.5 },
      style,
    ]}
  >
    {options.map((option) => {
      const selected = option.value === value;
      let color = selected ? colors.text : colors.textDim;
      if (accent) {
        color = selected ? colors.onAccent : colors.text;
      }
      return (
        <Pressable
          key={option.value}
          disabled={disabled}
          onPress={() => onChange(option.value)}
          // react-native-web adds `hovered` to the state.
          style={(state) => [
            styles.segment,
            accent && styles.segmentTall,
            selected && styles.segmentSelected,
            selected && accent && styles.segmentSelectedAccent,
            !selected &&
              accent &&
              (state as { hovered?: boolean }).hovered &&
              styles.segmentHovered,
          ]}
        >
          {option.icon && <Icon name={option.icon} color={color} size={18} />}
          <Text style={[styles.segmentLabel, { color }]}>{option.label}</Text>
        </Pressable>
      );
    })}
  </View>
);

const styles = StyleSheet.create({
  round: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    flex: 1,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    overflow: "hidden",
    shadowColor: colors.accent,
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
  },
  pillFill: {
    backgroundColor: colors.accent,
  },
  pillLabel: {
    color: colors.onAccent,
    fontSize: 17,
    fontWeight: "700",
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: 22,
    padding: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  segmentedAccent: {
    borderRadius: 26,
    borderWidth: 1,
    borderColor: "rgba(60, 227, 246, 0.35)",
  },
  segment: {
    flex: 1,
    height: 36,
    borderRadius: 18,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentTall: {
    height: 44,
    borderRadius: 22,
  },
  segmentSelected: {
    backgroundColor: colors.surfaceRaised,
  },
  segmentSelectedAccent: {
    backgroundColor: colors.accent,
  },
  segmentHovered: {
    backgroundColor: colors.surfaceRaised,
  },
  segmentLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
});
