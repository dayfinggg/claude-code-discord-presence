import { expect, test } from "vitest";
import { activityAssetsForTheme } from "../src/appearance/theme-assets.ts";

test("theme assets override the matching Discord keys", () => {
  const assets = {
    appName: "Codex",
    largeImageKey: "large-fallback",
    largeImageKeyLight: "large-light",
    largeImageKeyDark: "large-dark",
    smallImageKey: "small-fallback",
    smallImageKeyLight: "small-light",
    smallImageKeyDark: "small-dark",
  };

  expect(activityAssetsForTheme(assets, "light")).toMatchObject({
    largeImageKey: "large-light",
    smallImageKey: "small-light",
  });
  expect(activityAssetsForTheme(assets, "dark")).toMatchObject({
    largeImageKey: "large-dark",
    smallImageKey: "small-dark",
  });
});

test("theme assets keep the existing keys until themed assets are uploaded", () => {
  const resolved = activityAssetsForTheme(
    { appName: "Claude Code", largeImageKey: "large", smallImageKey: "small" },
    "dark",
  );

  expect(resolved.largeImageKey).toBe("large");
  expect(resolved.smallImageKey).toBe("small");
});
