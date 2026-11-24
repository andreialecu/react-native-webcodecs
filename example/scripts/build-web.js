// Builds the web demo as static files in web-build/, for GitHub Pages
// (.github/workflows/deploy-demo.yml): the bundle, its assets, and the page.
//
//   yarn build:web
//   npx serve web-build
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "web-build");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

execFileSync(
  "npx",
  [
    "react-native",
    "bundle",
    "--platform",
    "web",
    "--dev",
    "false",
    "--minify",
    "true",
    "--entry-file",
    "index.web.js",
    "--bundle-output",
    path.join(out, "index.js"),
    "--assets-dest",
    out,
  ],
  {
    cwd: root,
    stdio: "inherit",
    // Asset URLs relative to the page, so it works under any path.
    env: { ...process.env, IS_WEB_BUILD: "true", WEB_PUBLIC_PATH: "./assets" },
  },
);

// Metro copies the assets to publicPath minus its first character (it
// expects "/assets"): with "./assets" they land in "ssets".
if (fs.existsSync(path.join(out, "ssets"))) {
  fs.renameSync(path.join(out, "ssets"), path.join(out, "assets"));
}

// The page Metro serves in development, loading the static bundle instead.
const html = fs
  .readFileSync(path.join(root, "index.html"), "utf8")
  .replace(/<script src="index\.bundle[^"]*"/, '<script src="index.js"');
fs.writeFileSync(path.join(out, "index.html"), html);
fs.copyFileSync(
  path.join(root, "..", "docs", "app-export.gif"),
  path.join(out, "preview.gif"),
);
console.log(`Wrote ${out}`);
