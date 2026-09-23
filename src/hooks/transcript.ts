import fs from "node:fs";

export function readLastAssistantText(transcriptPath: string): string | null {
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, 200_000);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(transcriptPath, "r");
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === "assistant" && obj.message?.content) {
          const content = obj.message.content;
          const textParts = Array.isArray(content)
            ? content.filter((c: any) => c.type === "text").map((c: any) => c.text)
            : [];
          if (textParts.length) return textParts.join("\n");
        }
      } catch {
        // Partial line at the buffer boundary; skip it.
      }
    }
  } catch (err) {
    console.error("Failed to read transcript:", err);
  }
  return null;
}
