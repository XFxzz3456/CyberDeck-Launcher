from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
root = Path(__file__).resolve().parent.parent
assets = root / "assets"
assets.mkdir(exist_ok=True)

img = Image.new("RGBA", (SIZE, SIZE), (7, 9, 12, 255))
draw = ImageDraw.Draw(img)

# subtle grid
for i in range(0, SIZE, 64):
    draw.line([(i, 0), (i, SIZE)], fill=(255, 255, 255, 12), width=1)
    draw.line([(0, i), (SIZE, i)], fill=(255, 255, 255, 10), width=1)

# yellow cut-corner plate
pad = 88
cut = 250
plate = [
    (pad, pad),
    (SIZE - pad, pad),
    (SIZE - pad, SIZE - pad - cut),
    (SIZE - pad - cut, SIZE - pad),
    (pad, SIZE - pad),
]
draw.polygon(plate, fill=(252, 238, 10, 255))

# black notch
draw.polygon(
    [(SIZE - 250, SIZE - 160), (SIZE - 160, SIZE - 160), (SIZE - 160, SIZE - 250)],
    fill=(7, 9, 12, 255),
)

font_path = Path(r"C:\Windows\Fonts\bahnschrift.ttf")
if not font_path.exists():
    font_path = Path(r"C:\Windows\Fonts\arialbd.ttf")
font = ImageFont.truetype(str(font_path), 420)
text = "NC"
bbox = draw.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
x = (SIZE - tw) / 2 - bbox[0]
y = (SIZE - th) / 2 - bbox[1] - 20
draw.text((x, y), text, font=font, fill=(7, 9, 12, 255), stroke_width=0)

# small serial ticks
font_small = ImageFont.truetype(str(font_path), 38)
draw.text((pad + 26, SIZE - pad - 66), "// 2077", font=font_small, fill=(7, 9, 12, 210))

img.save(assets / "icon.png")
print(assets / "icon.png")
