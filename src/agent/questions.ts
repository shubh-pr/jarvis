import type { Question } from "../types.js";

// Claude's AskUserQuestion tool arrives through the PermissionRequest hook,
// but it isn't a "may this run?" gate — it's a multiple-choice question.
// Approving it without an answer just moves the question to the terminal
// (verified: Claude Code then shows it there and waits). Answering it means
// allowing it with `updatedInput.answers`, keyed by question text, each
// value an option label (an array for multi-select) or free text — the
// same shape the Agent SDK documents for canUseTool, and verified to reach
// Claude from a hook in an interactive session.

export type Answers = Record<string, string | string[]>;

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

// Readable text for the chat log and the push notification.
export function questionContent(questions: Question[]): string {
  return questions
    .map((q) => {
      const head = `Claude is asking${q.header ? ` (${q.header})` : ""}: ${q.question}`;
      const opts = q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
      return [head, ...opts].join("\n");
    })
    .join("\n\n");
}

type Result = { ok: true; answers: Answers } | { ok: false; error: string };

// Answers from the question card: every question answered, each with an
// option label (or labels, for multi-select) or non-empty free text.
export function validateAnswers(questions: Question[], raw: unknown): Result {
  if (!raw || typeof raw !== "object") return { ok: false, error: "No answers were given." };
  const given = raw as Record<string, unknown>;
  const answers: Answers = {};
  for (const q of questions) {
    const v = given[q.question];
    const labels = new Set(q.options.map((o) => o.label));
    if (typeof v === "string" && v.trim()) {
      answers[q.question] = v.trim();
    } else if (q.multiSelect && Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && labels.has(x))) {
      answers[q.question] = [...new Set(v as string[])];
    } else {
      return { ok: false, error: `"${q.question}" needs an answer.` };
    }
  }
  return { ok: true, answers };
}

// A typed reply to a question: an option number ("2", or "1,3" for
// multi-select), an option's exact label, or otherwise the text itself as a
// free-text answer. Only for single-question requests — several questions
// at once need the card.
export function answersFromText(questions: Question[], text: string): Result {
  if (questions.length !== 1) return { ok: false, error: "This asks several questions at once — answer them on the card." };
  const q = questions[0];
  const t = text.trim();
  if (!t) return { ok: false, error: "That answer was empty." };
  const numbers = /^\d+(\s*,\s*\d+)*$/.test(t) ? t.split(",").map((n) => Number(n.trim())) : undefined;
  if (numbers) {
    if (!q.multiSelect && numbers.length > 1) return { ok: false, error: "Pick just one option for this question." };
    if (numbers.some((n) => n < 1 || n > q.options.length)) {
      return { ok: false, error: `Options are numbered 1–${q.options.length}.` };
    }
    const labels = numbers.map((n) => q.options[n - 1].label);
    return { ok: true, answers: { [q.question]: q.multiSelect ? [...new Set(labels)] : labels[0] } };
  }
  const exact = q.options.find((o) => o.label.toLowerCase() === t.toLowerCase());
  if (exact) return { ok: true, answers: { [q.question]: q.multiSelect ? [exact.label] : exact.label } };
  return { ok: true, answers: { [q.question]: t } };
}

export function describeAnswers(answers: Answers): string {
  return Object.values(answers)
    .map((v) => (Array.isArray(v) ? v.join(", ") : v))
    .join(" · ");
}
