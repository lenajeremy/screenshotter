/**
 * The Claude Code skill for agents using the Screenshotter MCP server: the design guide plus the
 * working loop (capture → look → compose → check → refine) in terms of the MCP tools.
 * `npm run skill` writes it to skills/screenshot-design/SKILL.md.
 */
import { DESIGN_GUIDE } from "./guide.js";

export const SKILL_MD = `---
name: screenshot-design
description: Design App Store screenshots, product mockups, help-centre images and launch visuals with the Screenshotter MCP server. Use whenever you capture app or web screens and turn them into marketing images, device mockups, screenshot sets, how-to images or product videos, or when asked to make mockups look better.
---

# Screenshot design with Screenshotter

You have the Screenshotter MCP tools. Use them like a designer who checks their own work: look at every render, zoom into details, compare variants side by side, and refine until it's right.

## The loop

1. **Know the person.** Call \`get_house_style\` and follow it. \`list_mockup_options\` lists devices, finishes, looks (photographic, paintings, soft grounds), canvases, layouts and grades.
2. **Capture the real screen.** \`capture_screenshot\` (simulator; deep links or launch arguments reach a screen), \`capture_web\`, \`capture_mac\`. For motion: \`record_simulator\`, \`record_web\` (a rehearsed click-through that returns a cursor track) and \`record_mac\`.
3. **Read the screen.** Look at the capture. \`find_text\` lists its visible text: the words you can aim a callout at. Note its colours: the accent is your accent.
4. **Compose.** Start from a proven design with \`apply_recipe\` when one fits, or write the scene yourself with \`create_mockup\` and a clear idea (see the guide). \`layout_mockup\` shows where everything lands without rendering. For a whole set, \`create_mockup_set\`.
5. **Check.** Look at the preview. Then zoom in: \`crop_image\` with a \`focus\` and \`zoom\` on the headline edges, the callout, the device edge. Anything off (text touching the device, weak contrast, a callout on the wrong row), fix it and render again.
6. **Compare.** When the direction isn't obvious, render two or three variants (backdrop, layout, type) and lay them side by side with \`create_grid\` (with \`labels\`). Pick the strongest, say why, and refine it.
7. **Remember.** When the person states a preference ("always Space Black", "less text"), save it with \`remember_style\`.

Everything is a scene of entities (devices, the caption, texts) with positions as fractions of the canvas; every result lists them. Each output has a \`.mockup.json\` next to it with the exact request, so you can re-render with small changes.

${DESIGN_GUIDE}`;
