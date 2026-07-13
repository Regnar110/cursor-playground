#!/usr/bin/env python3
"""Annotate tme.eu screenshots with cache zone overlays."""

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ASSETS = Path("/workspace/apps/tmeNext/docs/assets/tme-eu-cache")

# Colors: RGBA
COLORS = {
    "shell": (46, 125, 50, 70),      # zielony — powłoka ISR / layout
    "remote_t": (25, 118, 210, 70),  # niebieski — remote kontrakt T
    "live": (245, 124, 0, 75),       # pomarańczowy — kontrakt L
    "dynamic_w": (198, 40, 40, 75),  # czerwony — kontrakt W / sesja
    "client": (97, 97, 97, 60),      # szary — tylko klient
}

BORDER = {
    "shell": (46, 125, 50, 255),
    "remote_t": (25, 118, 210, 255),
    "live": (245, 124, 0, 255),
    "dynamic_w": (198, 40, 40, 255),
    "client": (97, 97, 97, 255),
}


def font(size: int):
    for name in ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf", "LiberationSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_zone(draw, box, key: str, label: str, fnt):
    x1, y1, x2, y2 = box
    fill = COLORS[key]
    border = BORDER[key]
    draw.rectangle([x1, y1, x2, y2], fill=fill, outline=border, width=2)
    # label background
    tb = draw.textbbox((0, 0), label, font=fnt)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    lx, ly = x1 + 4, y1 + 4
    draw.rectangle([lx - 2, ly - 2, lx + tw + 6, ly + th + 4], fill=(255, 255, 255, 220))
    draw.text((lx + 2, ly), label, fill=border[:3], font=fnt)


def annotate_home(src: Path, dst: Path):
    img = Image.open(src).convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fnt = font(13)
    w, h = img.size

    zones = [
        ((0, 0, w, 32), "live", "L · sugestia regionu (IP)"),
        ((0, 32, w, 58), "shell", "POWŁOKA · pasek USP (statyczny)"),
        ((w - 420, 58, w, 95), "dynamic_w", "W · logowanie / panel"),
        ((w - 130, 58, w, 95), "dynamic_w", "W · koszyk / ulubione"),
        ((0, 95, w, 175), "shell", "POWŁOKA · header + search UI"),
        ((0, 175, 248, h), "remote_t", "T · drzewo kategorii (remote, dni)"),
        ((248, 175, w - 20, 520), "remote_t", "T · hero / promocje (remote, godziny)"),
        ((248, 520, w, h), "remote_t", "T · aktualności (remote, godziny)"),
        ((w // 2 - 200, h // 2 - 120, w // 2 + 200, h // 2 + 140), "client", "KLIENT · modal cookies"),
    ]
    for box, key, label in zones:
        draw_zone(draw, box, key, label, fnt)

    out = Image.alpha_composite(img, overlay)
    # legend
    leg = Image.new("RGBA", (w, 36), (255, 255, 255, 240))
    ld = ImageDraw.Draw(leg)
    lf = font(11)
    items = [
        ("POWŁOKA ISR", "shell"),
        ("REMOTE T", "remote_t"),
        ("LIVE L", "live"),
        ("DYNAMIC W", "dynamic_w"),
        ("KLIENT", "client"),
    ]
    x = 8
    for text, key in items:
        c = BORDER[key][:3]
        ld.rectangle([x, 10, x + 14, 24], fill=c)
        ld.text((x + 18, 8), text, fill=(0, 0, 0), font=lf)
        x += 120

    final = Image.new("RGB", (w, h + 36), (255, 255, 255))
    final.paste(out.convert("RGB"), (0, 0))
    final.paste(leg.convert("RGB"), (0, h))
    final.save(dst, quality=92)
    print(f"  → {dst.name}")


def annotate_product(src: Path, dst: Path):
    img = Image.open(src).convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fnt = font(13)
    w, h = img.size

    zones = [
        ((0, 0, w, 175), "shell", "POWŁOKA · header (wspólny layout)"),
        ((40, 195, 520, 240), "remote_t", "T · breadcrumb (remote)"),
        ((40, 250, 380, 520), "remote_t", "T · zdjęcie + opis PIM (remote, dni)"),
        ((400, 250, 900, 420), "remote_t", "T · parametry techniczne (remote, dni)"),
        ((900, 250, w - 20, 480), "live", "L · cennik progowy + stock (minuty)"),
        ((900, 480, w - 20, 560), "dynamic_w", "W · dodaj do koszyka"),
        ((40, 530, 520, 580), "remote_t", "T · dokumentacja PDF (remote, dni)"),
        ((w // 2 - 180, h // 2 - 100, w // 2 + 180, h // 2 + 120), "client", "KLIENT · cookies"),
    ]
    for box, key, label in zones:
        draw_zone(draw, box, key, label, fnt)

    out = Image.alpha_composite(img, overlay)
    leg = Image.new("RGBA", (w, 36), (255, 255, 255, 240))
    ld = ImageDraw.Draw(leg)
    lf = font(11)
    x = 8
    for text, key in [
        ("POWŁOKA ISR", "shell"),
        ("REMOTE T", "remote_t"),
        ("LIVE L", "live"),
        ("DYNAMIC W", "dynamic_w"),
    ]:
        c = BORDER[key][:3]
        ld.rectangle([x, 10, x + 14, 24], fill=c)
        ld.text((x + 18, 8), text, fill=(0, 0, 0), font=lf)
        x += 120

    final = Image.new("RGB", (w, h + 36), (255, 255, 255))
    final.paste(out.convert("RGB"), (0, 0))
    final.paste(leg.convert("RGB"), (0, h))
    final.save(dst, quality=92)
    print(f"  → {dst.name}")


def annotate_home_full(src: Path, dst: Path, max_height=2400):
    img = Image.open(src).convert("RGB")
    w, h = img.size
    if h > max_height:
        ratio = max_height / h
        img = img.resize((int(w * ratio), max_height), Image.Resampling.LANCZOS)
        w, h = img.size

    rgba = img.convert("RGBA")
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fnt = font(14)

    # proportional zones for full page
    zones = [
        ((0, 0, w, int(h * 0.12)), "shell", "POWŁOKA · header + nawigacja"),
        ((0, int(h * 0.12), int(w * 0.18), int(h * 0.45)), "remote_t", "T · kategorie"),
        ((int(w * 0.18), int(h * 0.12), w, int(h * 0.45)), "remote_t", "T · promocje"),
        ((0, int(h * 0.45), w, int(h * 0.62)), "remote_t", "T · aktualności"),
        ((0, int(h * 0.62), w, int(h * 0.72)), "remote_t", "T · usługi / skróty"),
        ((0, int(h * 0.72), w, int(h * 0.82)), "remote_t", "T · producenci"),
        ((0, int(h * 0.82), w, int(h * 0.90)), "remote_t", "T · o nas / CMS"),
        ((0, int(h * 0.90), w, h), "shell", "POWŁOKA · footer + newsletter UI"),
    ]
    for box, key, label in zones:
        draw_zone(draw, box, key, label, fnt)

    out = Image.alpha_composite(rgba, overlay)
    out.save(dst, quality=88)
    print(f"  → {dst.name}")


def make_legend_card(dst: Path):
    w, h = 900, 320
    img = Image.new("RGB", (w, h), (250, 250, 250))
    draw = ImageDraw.Draw(img)
    title_f = font(20)
    body_f = font(14)
    draw.text((24, 20), "Legenda — warstwy cache (Next.js 16 + Redis)", fill=(0, 0, 0), font=title_f)

    rows = [
        ("shell", "POWŁOKA (ISR)", "Layout, header, footer — wspólny snapshot HTML/RSC między 15 podami"),
        ("remote_t", "REMOTE · kontrakt T", "Katalog, CMS, PIM — cacheLife hours/days, bez revalidateTag"),
        ("live", "LIVE · kontrakt L", "Cena, stock — krótki TTL lub connection(), dynamiczna dziura"),
        ("dynamic_w", "DYNAMIC · kontrakt W", "Koszyk, konto, formularze — updateTag + connection() w Suspense"),
        ("client", "TYLKO KLIENT", "Cookies, modale, analytics — nie w server cache"),
    ]
    y = 60
    for key, title, desc in rows:
        c = BORDER[key][:3]
        draw.rectangle([24, y, 44, y + 20], fill=c)
        draw.text((52, y - 2), title, fill=(0, 0, 0), font=body_f)
        draw.text((240, y - 2), desc, fill=(60, 60, 60), font=body_f)
        y += 48

    img.save(dst, quality=92)
    print(f"  → {dst.name}")


if __name__ == "__main__":
    print("Annotating screenshots...")
    annotate_home(ASSETS / "01-home.png", ASSETS / "01-home-annotated.png")
    annotate_product(ASSETS / "03-product.png", ASSETS / "03-product-annotated.png")
    annotate_home_full(ASSETS / "01-home-full.png", ASSETS / "01-home-full-annotated.png")
    make_legend_card(ASSETS / "00-legend.png")
    print("Done.")
