import type { LinkingOptions } from "@react-navigation/native";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { Routes } from "./Route";
import { Home } from "./Home";
import { Tests } from "./Tests";
import { VideoExport } from "./VideoExport";
import { Compress } from "./Compress";

const CI = process.env.CI === "true";

const Stack = createStackNavigator<Routes>();

// Deep links, one path per screen.
const linking: LinkingOptions<Routes> = {
  config: {
    screens: {
      Home: "",
      Tests: "tests",
      VideoExport: "video-export",
      HDRExport: "hdr-export",
      Compress: "compress",
    },
  },
  // react-native-test-app registers the bundle id as the iOS URL scheme.
  prefixes: ["com.reactnativewebcodecs.example://"],
};

function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationContainer linking={linking}>
          <Stack.Navigator
            initialRouteName={CI ? "Tests" : "Home"}
            screenOptions={{ cardStyle: { flex: 1 } }}
          >
            <Stack.Screen name="Home" component={Home} />
            <Stack.Screen name="Tests" component={Tests} />
            <Stack.Screen
              name="VideoExport"
              component={VideoExport}
              options={{ title: "Video Export", headerShown: false }}
            />
            <Stack.Screen
              name="Compress"
              component={Compress}
              options={{ title: "Compress", headerShown: false }}
            />
            <Stack.Screen
              name="HDRExport"
              component={VideoExport}
              initialParams={{ hdr: true }}
              options={{ title: "HDR Video Export", headerShown: false }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// eslint-disable-next-line import/no-default-export
export default App;
