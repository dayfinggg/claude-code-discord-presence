function basename(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") return "a file";
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "");
  const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
  return segment === "" ? "a file" : segment;
}

function filePath(toolInput?: Record<string, unknown>): unknown {
  if (!toolInput) return undefined;
  return toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
}

const STATIC_LABELS: Record<string, string> = {
  Grep: "Searching files",
  Glob: "Searching files",
  Bash: "Running a command",
  PowerShell: "Running a command",
  Agent: "Delegating to agents",
  WebSearch: "Searching the web",
  WebFetch: "Browsing the web",
  TaskCreate: "Managing tasks",
  TaskUpdate: "Managing tasks",
  TaskList: "Managing tasks",
  TaskGet: "Managing tasks",
  TaskStop: "Managing tasks",
  TodoWrite: "Managing tasks",
  Skill: "Running a skill",
  SlashCommand: "Running a skill",
  EnterPlanMode: "Planning",
  ExitPlanMode: "Planning",
  AskUserQuestion: "Waiting for input",
  Workflow: "Orchestrating agents",
  Monitor: "Watching background work",
  TaskOutput: "Watching background work",
};

export function toolLabel(toolName: string | undefined, toolInput?: Record<string, unknown>): string {
  if (!toolName) return "Working";

  if (toolName.startsWith("mcp__")) {
    const server = toolName.split("__")[1];
    return server ? `Using ${server}` : "Working";
  }

  switch (toolName) {
    case "Read":
      return `Reading ${basename(filePath(toolInput))}`;
    case "Edit":
    case "NotebookEdit":
      return `Editing ${basename(filePath(toolInput))}`;
    case "Write":
      return `Writing ${basename(filePath(toolInput))}`;
    default:
      break;
  }

  return STATIC_LABELS[toolName] ?? "Working";
}
