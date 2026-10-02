"""Gera os arquivos de identidade visual do Quack (SVG + PNG) a partir do PDF
da marca.  Uso, na raiz do projeto:

    pip install pypdf fonttools resvg-py
    python tools/build-brand.py "Logo - Quack.pdf"

Os índices abaixo são posições dos itens extraídos por pdf2svg.py (ordem de
desenho do PDF, página 1): 0-5 mascote colorido, 6-36 "uack" + ™ + tagline,
37-74 versão empilhada, 75-86 contorno, 87-102 ícones de app, 103-139 versão
para fundo escuro."""
import json, os, subprocess, sys, tempfile
import resvg_py
from fontTools.svgLib.path import parse_path
from fontTools.pens.boundsPen import BoundsPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INK, YELLOW, ORANGE = "#1D1A18", "#FBCF24", "#F7A324"

def load(pdf):
    tmp = os.path.join(tempfile.mkdtemp(), "items.json")
    subprocess.check_call([sys.executable, os.path.join(ROOT, "tools", "pdf2svg.py"), pdf, tmp])
    return json.load(open(tmp))

def bounds(items):
    xs, ys, xe, ye = 1e9, 1e9, -1e9, -1e9
    for it in items:
        bp = BoundsPen(None); parse_path(it["d"], bp)
        if bp.bounds:
            xs, ys = min(xs, bp.bounds[0]), min(ys, bp.bounds[1])
            xe, ye = max(xe, bp.bounds[2]), max(ye, bp.bounds[3])
    return xs, ys, xe, ye

def pad_box(b, pad):
    x0, y0, x1, y1 = b
    return (x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad)

def paths(items, fill=None, cls=None):
    return "".join('<path%s d="%s" fill="%s"/>' % ((' class="%s"' % cls) if cls else "", it["d"], fill or it["fill"]) for it in items)

def svg(box, body, extra=""):
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%.1f %.1f %.1f %.1f"%s>%s</svg>\n' % (box + (extra, body))

def write(path, text, mode="w"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode, **({} if "b" in mode else {"encoding": "utf8"})) as f:
        f.write(text)

def png(svg_text, size, path):
    write(path, bytes(resvg_py.svg_to_bytes(svg_string=svg_text, width=size, height=size)), "wb")

def main(pdf):
    it = load(pdf)
    S = lambda a, b: it[a:b]
    brand = os.path.join(ROOT, "assets", "brand")

    # ---- mascote colorido (contorno / corpo / asa / bico / olho) ----
    duck = S(0, 6)
    dbox = pad_box(bounds(duck), 4)
    write(os.path.join(brand, "quack-mark.svg"), svg(dbox, paths(duck)))
    # ---- logo horizontal: mascote + "uack" (+ tagline) ----
    word = S(6, 10)
    tm = S(10, 11); tag = S(11, 37)
    write(os.path.join(brand, "quack-logo.svg"), svg(pad_box(bounds(duck + word + tm + tag), 6), paths(duck + word + tm + tag)))
    write(os.path.join(brand, "quack-logo-compact.svg"), svg(pad_box(bounds(duck + word + tm), 6), paths(duck + word + tm)))
    # ---- versão para fundo escuro: mascote sem contorno + texto branco ----
    dd, dw, dtm, dtag = S(104, 108), S(109, 113), S(113, 114), S(114, 140)
    write(os.path.join(brand, "quack-logo-dark.svg"), svg(pad_box(bounds(dd + dw + dtm + dtag), 6), paths(dd + dw + dtm + dtag)))
    # ---- contorno (monocromático) ----
    outline = [it[88], it[93]]
    obox = pad_box(bounds(outline), 4)
    write(os.path.join(brand, "quack-mark-outline.svg"), svg(obox, paths(outline, INK)))

    # e-mail: cliente de e-mail não renderiza SVG, então vai um PNG (fundo transparente)
    compact = open(os.path.join(brand, "quack-logo-compact.svg"), encoding="utf8").read()
    write(os.path.join(brand, "quack-logo-email.png"), bytes(resvg_py.svg_to_bytes(svg_string=compact, width=480)), "wb")

    # ---- ícone de app: quadrado amarelo cheio (o sistema arredonda / mascara) ----
    ob = bounds(outline)
    ow, oh = ob[2] - ob[0], ob[3] - ob[1]
    def icon_svg(scale, bg=YELLOW, fg=INK, rounded=0):
        side = max(ow, oh) / scale                  # lado do quadrado em unidades do PDF
        cx, cy = (ob[0] + ob[2]) / 2, (ob[1] + ob[3]) / 2
        box = (cx - side / 2, cy - side / 2, side, side)
        rx = ' rx="%.1f"' % (side * rounded) if rounded else ""
        bgr = '<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s"%s/>' % (box + (bg, rx))
        return svg(box, bgr + paths(outline, fg))
    # 0.6 = zona segura do maskable (círculo de 80%) com folga
    full = icon_svg(0.60)
    png(full, 512, os.path.join(ROOT, "icons", "icon-512.png"))
    png(full, 192, os.path.join(ROOT, "icons", "icon-192.png"))
    png(full, 180, os.path.join(ROOT, "icons", "apple-touch-icon.png"))
    write(os.path.join(ROOT, "icons", "favicon.svg"), icon_svg(0.72, rounded=0.22))
    png(icon_svg(0.72, rounded=0.22), 32, os.path.join(ROOT, "icons", "favicon-32.png"))
    # ---- sprite inline no index.html (<use href="#quack-duck">, etc.) ----
    # quack-duck: mascote no quadro 32x32 dos patinhos antigos (cabeça/olho no mesmo
    #   lugar, então os acessórios desenhados por cima continuam alinhados);
    # quack-mark: mascote com proporção real (cabeçalho);  quack-word: "uack".
    s = 27 / (dbox[2] - 8)                      # largura do mascote -> 27 unidades
    x0, y0 = dbox[0] + 4, dbox[1] + 4          # canto do mascote (sem a folga de 4)
    grid = '<g transform="translate(4.2 3.6) scale(%.4f) translate(%.1f %.1f)">' % (s, -x0, -y0)
    ol = 'var(--duck-ol,%s)' % INK
    def duck_paths(items):
        return "".join('<path d="%s" fill="%s"/>' % (i["d"], ol if i["fill"] == INK and n == 0 else i["fill"]) for n, i in enumerate(items))
    mbox = pad_box(bounds(duck), 0)
    wbox = pad_box(bounds(word), 0)
    sprite = ('<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>'
              '<symbol id="quack-duck" viewBox="0 0 32 32">%s%s</g></symbol>'
              '<symbol id="quack-mark" viewBox="%.1f %.1f %.1f %.1f">%s</symbol>'
              '<symbol id="quack-word" viewBox="%.1f %.1f %.1f %.1f">%s</symbol>'
              '</defs></svg>') % ((grid, duck_paths(duck)) + mbox + (duck_paths(duck),) + wbox + (paths(word, "currentColor"),))
    html_path = os.path.join(ROOT, "index.html")
    html = open(html_path, encoding="utf8").read()
    a, b = "<!-- brand-sprite:start -->", "<!-- brand-sprite:end -->"
    i, j = html.index(a) + len(a), html.index(b)
    open(html_path, "w", encoding="utf8", newline="").write(html[:i] + "\n" + sprite + "\n" + html[j:])
    print("ok", "mark %.1fx%.1f" % mbox[2:], "word %.1fx%.1f" % wbox[2:])

main(sys.argv[1])
