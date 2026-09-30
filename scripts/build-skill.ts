/** Writes the Claude Code skill (skills/screenshot-design/SKILL.md) from the design guide. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SKILL_MD } from "../src/design/skill.js";

const out = path.join(import.meta.dirname, "..", "skills", "screenshot-design", "SKILL.md");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, SKILL_MD);
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
