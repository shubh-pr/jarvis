import type { Question } from "../../../types.js";

// Claude's AskUserQuestion tool arrives through the PermissionRequest hook,
// but it isn't a "may this run?" gate — it's a multiple-choice question.
// Approving it without an answer just moves the question to the terminal
// (verified: Claude Code then shows it there and waits). Answering it means
// allowing it with `updatedInput.answers`, keyed by question text, each
// value an option label (an array for multi-select) or free text — the
// same shape the Agent SDK documents for canUseTool, and verified to reach
// Claude from a hook in an interactive session.

export function parseQuestions(toolName: string, input: any): Question[] | undefined {
  if (toolName !== "AskUserQuestion" || !Array.isArray(input?.questions) || !input.questions.length) return undefined;
  const questions: Question[] = [];
  for (const q of input.questions) {
    if (typeof q?.question !== "string" || !Array.isArray(q.options)) return undefined;
    const options = q.options
      .filter((o: any) => typeof o?.label === "string")
      .map((o: any) => ({ label: o.label, description: typeof o.description === "string" ? o.description : undefined }));
    if (!options.length) return undefined;
    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return questions;
}
