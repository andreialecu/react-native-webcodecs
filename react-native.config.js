module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: {
        packageImportPath: "import com.margelo.nitro.webcodecs.NitroWebCodecsPackage;",
        packageInstance: "new NitroWebCodecsPackage()",
      },
    },
  },
};
