export interface AutostartDefinition {
  label: string;
  description: string;
  nodePath: string;
  projectDir: string;
  envFile?: string;
  entryPoint: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function createLaunchAgentPlist(definition: AutostartDefinition): string {
  const args = [
    definition.nodePath,
    "--disable-warning=ExperimentalWarning",
    ...(definition.envFile ? [`--env-file=${definition.envFile}`] : []),
    "--enable-source-maps",
    definition.entryPoint,
  ];
  const renderedArgs = args.map((arg) => `      <string>${xml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(definition.label)}</string>
    <key>ProgramArguments</key>
    <array>
${renderedArgs}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(definition.projectDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
  </dict>
</plist>
`;
}

export function createSystemdUserUnit(definition: AutostartDefinition): string {
  const command = [
    definition.nodePath,
    "--disable-warning=ExperimentalWarning",
    ...(definition.envFile ? [`--env-file=${definition.envFile}`] : []),
    "--enable-source-maps",
    definition.entryPoint,
  ]
    .map(systemdQuote)
    .join(" ");
  return `[Unit]
Description=${definition.description}
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(definition.projectDir)}
ExecStart=${command}
Restart=on-failure
RestartSec=10
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
`;
}
