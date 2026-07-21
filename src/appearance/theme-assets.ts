import type { ActivityAssets } from "../discord/presence-builder.ts";

export type ResolvedTheme = "light" | "dark";

export interface ThemedActivityAssets extends ActivityAssets {
  largeImageKeyLight?: string;
  largeImageKeyDark?: string;
  smallImageKeyLight?: string;
  smallImageKeyDark?: string;
}

export function activityAssetsForTheme(
  assets: ThemedActivityAssets,
  theme: ResolvedTheme,
): ActivityAssets {
  return {
    appName: assets.appName,
    largeImageKey:
      theme === "dark"
        ? assets.largeImageKeyDark ?? assets.largeImageKey
        : assets.largeImageKeyLight ?? assets.largeImageKey,
    largeImageUrl: assets.largeImageUrl,
    smallImageKey:
      theme === "dark"
        ? assets.smallImageKeyDark ?? assets.smallImageKey
        : assets.smallImageKeyLight ?? assets.smallImageKey,
    smallImageUrl: assets.smallImageUrl,
  };
}
