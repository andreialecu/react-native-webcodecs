import * as React from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { CommonActions, useNavigation } from "@react-navigation/native";
import type { StackNavigationProp } from "@react-navigation/stack";

import type { Routes } from "./Route";

export const examples = [
  {
    screen: "VideoExport",
    title: "🎬 Video Export (Skia, WebGPU, Mediabunny)",
  },
  {
    screen: "HDRExport",
    title: "🌟 HDR Video Export (HEVC 10-bit, HLG)",
  },
  {
    screen: "Compress",
    title: "🗜️ Compress a video (pick, scale, re-encode)",
  },
  {
    screen: "Tests",
    title: "🧪 E2E Tests",
  },
] as const;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    marginBottom: 32,
  },
  thumbnail: {
    backgroundColor: "white",
    padding: 32,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { color: "black" },
});

export const Home = () => {
  const navigation = useNavigation<StackNavigationProp<Routes, "Home">>();
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {examples.map((thumbnail) => (
        <TouchableOpacity
          key={thumbnail.screen}
          onPress={() =>
            navigation.dispatch(CommonActions.navigate(thumbnail.screen))
          }
        >
          <View style={styles.thumbnail}>
            <Text style={styles.title}>{thumbnail.title}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
};
