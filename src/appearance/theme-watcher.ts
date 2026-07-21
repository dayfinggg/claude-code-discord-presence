import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ResolvedTheme } from "./theme-assets.ts";

const execFileAsync = promisify(execFile);

export type ThemePreference = ResolvedTheme | "system";

export interface AppearanceThemes {
  claude: ResolvedTheme;
  codex: ResolvedTheme;
}

export interface AppearanceThemeWatcherOptions {
  codexHome?: string;
  claudeConfigPath?: string;
  claudeLevelDbDir?: string;
  pollIntervalMs?: number;
}

function defaultClaudeDataDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming"), "Claude");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude");
  }
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "Claude");
}

function normalizeThemePreference(value: unknown): ThemePreference | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.toLowerCase();
  if (raw === "auto" || raw === "system") return "system";
  return raw === "light" || raw === "dark" ? raw : undefined;
}

export function parseCodexThemePreference(text: string): ThemePreference | undefined {
  const match = /^\s*appearanceTheme\s*=\s*["']?(light|dark|system)["']?\s*(?:#.*)?$/im.exec(text);
  return match?.[1]?.toLowerCase() as ThemePreference | undefined;
}

export function parseClaudeThemePreference(data: Uint8Array | string): ThemePreference | undefined {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
  const matches = [...text.matchAll(/userTheme[\s\S]{0,96}?(auto|system|light|dark)/gi)];
  return normalizeThemePreference(matches.at(-1)?.[1]);
}

export function parseClaudeConfigTheme(text: string): ThemePreference | undefined {
  try {
    const config = JSON.parse(text) as Record<string, unknown>;
    return normalizeThemePreference(config.userThemeMode ?? config.userTheme);
  } catch {
    return undefined;
  }
}

export function readClaudeConfigTheme(path: string): ThemePreference | undefined {
  try {
    return parseClaudeConfigTheme(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function resolveTheme(
  preference: ThemePreference | undefined,
  systemTheme: ResolvedTheme,
): ResolvedTheme {
  return preference === "light" || preference === "dark" ? preference : systemTheme;
}

function readCodexPreference(codexHome: string | undefined): ThemePreference | undefined {
  if (!codexHome) return undefined;
  try {
    return parseCodexThemePreference(readFileSync(join(codexHome, "config.toml"), "utf8"));
  } catch {
    return undefined;
  }
}

async function readSystemTheme(): Promise<ResolvedTheme> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "reg.exe",
        [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
          "/v",
          "AppsUseLightTheme",
        ],
        { windowsHide: true },
      );
      const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
      if (match?.[1]) return Number.parseInt(match[1], 16) === 0 ? "dark" : "light";
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("defaults", ["read", "-g", "AppleInterfaceStyle"]);
      return /dark/i.test(stdout) ? "dark" : "light";
    } else {
      const { stdout } = await execFileAsync("gsettings", [
        "get",
        "org.gnome.desktop.interface",
        "color-scheme",
      ]);
      return /dark/i.test(stdout) ? "dark" : "light";
    }
  } catch {
    return "light";
  }
  return "light";
}

function themesEqual(a: AppearanceThemes | undefined, b: AppearanceThemes): boolean {
  return a?.claude === b.claude && a.codex === b.codex;
}

export class AppearanceThemeWatcher {
  private readonly codexHome?: string;
  private readonly claudeConfigPath: string;
  private readonly claudeLevelDbDir: string;
  private readonly pollIntervalMs: number;
  private readonly onChange: (themes: AppearanceThemes) => void;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private current?: AppearanceThemes;
  private claudePreference?: ThemePreference;
  private claudeFileSignatures = new Map<string, string>();

  constructor(
    options: AppearanceThemeWatcherOptions,
    onChange: (themes: AppearanceThemes) => void,
  ) {
    const claudeDataDir = defaultClaudeDataDir();
    this.codexHome = options.codexHome;
    this.claudeConfigPath = options.claudeConfigPath || join(claudeDataDir, "config.json");
    this.claudeLevelDbDir =
      options.claudeLevelDbDir || join(claudeDataDir, "Local Storage", "leveldb");
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.onChange = onChange;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const systemTheme = await readSystemTheme();
      const themes: AppearanceThemes = {
        claude: resolveTheme(this.readClaudePreference(), systemTheme),
        codex: resolveTheme(readCodexPreference(this.codexHome), systemTheme),
      };
      if (!themesEqual(this.current, themes)) {
        this.current = themes;
        this.onChange(themes);
      }
    } finally {
      this.polling = false;
    }
  }

  private readClaudePreference(): ThemePreference | undefined {
    const configPreference = readClaudeConfigTheme(this.claudeConfigPath);
    if (configPreference) {
      this.claudePreference = configPreference;
      return configPreference;
    }
    if (!existsSync(this.claudeLevelDbDir)) return this.claudePreference;
    try {
      const candidates = readdirSync(this.claudeLevelDbDir)
        .filter((name) => /\.(?:ldb|log)$/i.test(name))
        .map((name) => {
          const path = join(this.claudeLevelDbDir, name);
          const stats = statSync(path);
          return {
            path,
            modifiedAt: stats.mtimeMs,
            signature: `${stats.mtimeMs}:${stats.size}`,
          };
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt);

      let latest: ThemePreference | undefined;
      const signatures = new Map<string, string>();
      for (const candidate of candidates) {
        signatures.set(candidate.path, candidate.signature);
        if (this.claudeFileSignatures.get(candidate.path) === candidate.signature) continue;
        const preference = parseClaudeThemePreference(readFileSync(candidate.path));
        if (!latest && preference) latest = preference;
      }
      this.claudeFileSignatures = signatures;
      if (latest) this.claudePreference = latest;
    } catch {
      return this.claudePreference;
    }
    return this.claudePreference;
  }
}
