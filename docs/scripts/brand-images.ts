// Renders the PNG branding from src/assets/logo.svg. Run with: bun run brand
import { writeBrandImages } from "@timmo001/docs-kit";

const written = await writeBrandImages({
  logo: "src/assets/logo.svg",
  title: "effect-gh",
  tagline: ["An Effect v4 SDK", "for the GitHub CLI."],
  site: "effect-gh.timmo.dev",
  background: "#18181b",
  accent: "#a1a1aa",
  outputs: {
    socialPreview: "../.github/social-preview.png",
    logo: "public/logo.png",
    appleTouchIcon: "public/apple-touch-icon.png",
  },
});

for (const file of written) console.log(`Wrote ${file}`);
