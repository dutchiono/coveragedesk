import os
from PIL import Image, ImageDraw, ImageFont

# Brand colors
COLOR_LIME = (212, 240, 125)    # #d4f07d
COLOR_DARK = (24, 32, 29)       # #18201d
COLOR_WHITE = (255, 255, 255)
COLOR_MUTED = (160, 174, 192)

def get_font(size: int, bold: bool = True):
    # Try system fonts
    font_names = [
        "arialbd.ttf" if bold else "arial.ttf",
        "seguiemj.ttf",
        "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    ]
    for font_name in font_names:
        try:
            return ImageFont.truetype(font_name, size)
        except Exception:
            pass
    return ImageFont.load_default()

def create_pfp():
    size = 1000
    img = Image.new("RGB", (size, size), COLOR_LIME)
    draw = ImageDraw.Draw(img)
    
    font = get_font(380, bold=True)
    text = "CD"
    
    # Measure text
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    
    x = (size - text_w) / 2
    y = (size - text_h) / 2 - bbox[1]
    
    draw.text((x, y), text, fill=COLOR_DARK, font=font)
    
    output_path = os.path.join("public", "pfp.png")
    img.save(output_path, "PNG")
    print(f"Generated clean PFP: {output_path}")

def create_banner():
    width = 1500
    height = 500
    img = Image.new("RGB", (width, height), COLOR_DARK)
    draw = ImageDraw.Draw(img)
    
    # Draw subtle background grid lines
    grid_color = (35, 46, 42)
    for x in range(0, width, 50):
        draw.line([(x, 0), (x, height)], fill=grid_color, width=1)
    for y in range(0, height, 50):
        draw.line([(0, y), (width, y)], fill=grid_color, width=1)

    # Left Brand Box
    box_size = 180
    box_x = 100
    box_y = (height - box_size) // 2
    draw.rectangle([box_x, box_y, box_x + box_size, box_y + box_size], fill=COLOR_LIME)
    
    box_font = get_font(72, bold=True)
    box_text = "CD"
    bbox_box = draw.textbbox((0, 0), box_text, font=box_font)
    bw = bbox_box[2] - bbox_box[0]
    bh = bbox_box[3] - bbox_box[1]
    draw.text((box_x + (box_size - bw)/2, box_y + (box_size - bh)/2 - bbox_box[1]), box_text, fill=COLOR_DARK, font=box_font)
    
    # Title Text
    title_x = box_x + box_size + 50
    title_y = box_y + 35
    title_font = get_font(78, bold=True)
    draw.text((title_x, title_y), "COVERAGEDESK", fill=COLOR_WHITE, font=title_font)
    
    # Subtitle
    sub_y = title_y + 85
    sub_font = get_font(32, bold=True)
    draw.text((title_x, sub_y), "AGENTIC SPORTS SPREAD PROTOCOL", fill=COLOR_LIME, font=sub_font)

    output_path = os.path.join("public", "banner.png")
    img.save(output_path, "PNG")
    print(f"Generated clean 3:1 Banner: {output_path}")

if __name__ == "__main__":
    create_pfp()
    create_banner()
