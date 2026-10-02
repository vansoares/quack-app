"""Converte o PDF da identidade visual do Quack (1 página, só vetores + 2 fontes
Type1C subsetadas) em itens SVG, para montar os arquivos de logo do app.
Uso: python tools/pdf2svg.py "Logo - Quack.pdf" saida.json"""
import sys, re, json
from io import BytesIO
from pypdf import PdfReader
from fontTools.cffLib import CFFFontSet
from fontTools.agl import UV2AGL
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

PAL = {  # cmyk (arredondado) -> cor da marca
    (0.705, 0.658, 0.652, 0.786): "#1D1A18", (0.703, 0.657, 0.674, 0.786): "#1D1A18",
    (0.015, 0.172, 0.941, 0): "#FBCF24", (0.016, 0.17, 0.939, 0): "#FBCF24",
    (0.006, 0.413, 0.969, 0): "#F7A324", (0.01, 0.414, 0.971, 0.001): "#F7A324",
    (0, 0, 0, 0): "#FFFFFF", (0, 0, 0, 1): "#1D1A18",
}

def mul(a, b):  # matrizes PDF [a b c d e f]; resultado = a aplicada primeiro, depois b
    return [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3], a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3],
            a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5]]

def load_fonts(page):
    fonts = {}
    for k, v in page['/Resources']['/Font'].items():
        v = v.get_object(); d = v['/FontDescriptor'].get_object()
        cff = CFFFontSet(); cff.decompile(BytesIO(d['/FontFile3'].get_object().get_data()), None)
        top = cff[cff.fontNames[0]]; cs = top.CharStrings
        widths = {int(v['/FirstChar']) + i: w for i, w in enumerate(v['/Widths'])}
        enc = {}
        for code in range(256):
            try: enc[code] = top.Encoding[code]
            except Exception: pass
        fonts[k[1:]] = (cs, widths, enc, top.charset)
    return fonts

def main(src, dst):
    page = PdfReader(src).pages[0]
    fonts = load_fonts(page)
    STR = r'\((?:\\.|[^\\)])*\)'
    TOK = r'\[(?:' + STR + r'|[^\]])*\]|' + STR + r'|/[\w.]+|[-+]?\d*\.?\d+|[A-Za-z*\'"]+'
    toks = re.findall(TOK, page.get_contents().get_data().decode('latin1'))
    FLIP = [1, 0, 0, -1, 0, 1080]
    ctm = [1, 0, 0, 1, 0, 0]; stack = []; st = {}; fill = "#000"; items = []
    path = []; cur = None; args = []
    tm = tlm = None; font = None; tc = 0; clip = None; fcmyk = (0, 0, 0, 1)
    def P(x, y):
        m = mul(ctm, FLIP); return (x*m[0]+y*m[2]+m[4], x*m[1]+y*m[3]+m[5])
    def fmt(v): return ('%.2f' % v).rstrip('0').rstrip('.')
    for t in toks:
        if re.fullmatch(r'[-+]?\d*\.?\d+', t) or t[0] in '[(/':
            args.append(t); continue
        a = args
        if t == 'q': stack.append((ctm[:], fill, clip))
        elif t == 'Q': ctm, fill, clip = stack.pop()
        elif t == 'cm': ctm = mul([float(x) for x in a[-6:]], ctm)
        elif t == 'k':
            fcmyk = tuple(round(float(x), 3) for x in a[-4:])
            fill = PAL.get(fcmyk) or PAL.get(tuple(round(x, 2) for x in fcmyk)) or "#1D1A18"
        elif t == 'm': path.append('M%s %s' % tuple(map(fmt, P(*map(float, a[-2:])))))
        elif t == 'l': path.append('L%s %s' % tuple(map(fmt, P(*map(float, a[-2:])))))
        elif t == 'c':
            n = [float(x) for x in a[-6:]]; pts = [P(n[i], n[i+1]) for i in (0, 2, 4)]
            path.append('C' + ' '.join('%s %s' % (fmt(x), fmt(y)) for x, y in pts))
        elif t == 'h': path.append('Z')
        elif t == 're':
            x, y, w, h = [float(v) for v in a[-4:]]
            p = [P(x, y), P(x+w, y), P(x+w, y+h), P(x, y+h)]
            path.append('M' + ' L'.join('%s %s' % (fmt(px), fmt(py)) for px, py in p) + 'Z')
        elif t == 'W': pass
        elif t == 'n':
            clip = ' '.join(path) if path else clip; path = []   # só clip de prancheta
        elif t in ('f', 'f*'):
            if path: items.append({'type': 'path', 'd': ' '.join(path), 'fill': fill, 'rule': 'evenodd' if t == 'f*' else 'nonzero', 'clip': clip})
            path = []
        elif t == 'BT': tm = tlm = [1, 0, 0, 1, 0, 0]
        elif t == 'Tf': font = a[-2][1:]
        elif t == 'Tc': tc = float(a[-1])
        elif t == 'Tm': tm = tlm = [float(x) for x in a[-6:]]
        elif t in ('TJ', 'Tj'):
            cs, widths, enc, charset = fonts[font]
            parts = re.findall(STR + r'|[-+]?\d*\.?\d+', a[-1])
            x = 0.0
            for s in parts:
                if s[0] == '(':
                    unesc = lambda m: chr(int(m.group(1), 8)) if len(m.group(1)) == 3 else m.group(1)
                    raw = bytes(re.sub(r'\\(\d{3}|.)', unesc, s[1:-1]), 'latin1')
                    for code in raw:
                        gname = UV2AGL.get(ord(bytes([code]).decode('cp1252')), '.notdef')  # WinAnsi -> nome do glifo
                        pen = SVGPathPen(cs)
                        # glifo (unidades 1000) -> espaço de texto -> página
                        g = mul(mul([0.001, 0, 0, 0.001, x, 0], tm), mul(ctm, FLIP))
                        tp = TransformPen(pen, g); cs[gname].draw(tp)
                        d = pen.getCommands()
                        if d: items.append({'type': 'path', 'd': d, 'fill': PAL.get(fcmyk, "#1D1A18"), 'rule': 'nonzero', 'clip': clip, 'glyph': gname})
                        x += widths.get(code, 0) / 1000.0 + tc
                else:
                    x -= float(s) / 1000.0
        args = []
    json.dump(items, open(dst, 'w'))
    print(len(items), 'itens')
main(sys.argv[1], sys.argv[2])
