import sys
from PIL import Image, ImageDraw
out, *names = sys.argv[1:]
cells = [Image.open(f"shots/{n}.png").convert("RGB") for n in names]
W, H = 1000, 625
sheet = Image.new("RGB", (W * 2, H * ((len(cells) + 1) // 2)), "#333")
d = ImageDraw.Draw(sheet)
for i, im in enumerate(cells):
    im = im.resize((W, int(im.height * W / im.width)))
    x, y = (i % 2) * W, (i // 2) * H
    sheet.paste(im.crop((0, 0, W, H)), (x, y))
    d.rectangle((x, y, x + 260, y + 26), fill="#000"); d.text((x + 6, y + 6), names[i], fill="#ff0")
sheet.save(f"shots/{out}.png")
