import { writeFile } from "node:fs/promises";

export async function emitJson(value: unknown, outputPath?: string): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;

  if (outputPath !== undefined) {
    await writeFile(outputPath, serialized, "utf8");
  }

  process.stdout.write(serialized);
}
