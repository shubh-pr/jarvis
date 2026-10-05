import { commandTags, sentence, shortPath, hostOf, guessBashTitle, type RequestSummary } from "../../describe.js";

// Claude Code's tool names, in plain English. For Bash, the title is the
// one-line description Claude writes for every command.
export function describeRequest(toolName: string, input: any, cwd: string): RequestSummary {
  switch (toolName) {
    case "Bash": {
      const command = String(input?.command ?? "");
      const described = typeof input?.description === "string" && input.description.trim();
      return {
        title: described ? sentence(input.description) : guessBashTitle(command),
        tags: commandTags(command),
        detail: command,
      };
    }
    case "Edit":
    case "MultiEdit":
      return { title: `Edit ${shortPath(input?.file_path, cwd)}`, tags: ["writes files"], detail: input?.file_path };
    case "Write":
      return { title: `Create or overwrite ${shortPath(input?.file_path, cwd)}`, tags: ["writes files"], detail: input?.file_path };
    case "NotebookEdit":
      return { title: `Edit notebook ${shortPath(input?.notebook_path, cwd)}`, tags: ["writes files"], detail: input?.notebook_path };
    case "WebFetch":
      return { title: `Open ${hostOf(input?.url)}`, tags: ["goes online"], detail: input?.url };
    case "WebSearch":
      return { title: `Search the web for "${String(input?.query ?? "")}"`, tags: ["goes online"] };
    case "Read":
      return { title: `Read ${shortPath(input?.file_path, cwd)}`, tags: [], detail: input?.file_path };
    case "Glob":
    case "Grep":
      return { title: `Search files for ${JSON.stringify(input?.pattern ?? "")}`, tags: [], detail: input?.path };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
      if (mcp) return { title: `Use ${mcp[2].replace(/_/g, " ")} (${mcp[1]})`, tags: [], detail: JSON.stringify(input) };
      return { title: `Use ${toolName}`, tags: [], detail: JSON.stringify(input) };
    }
  }
}
