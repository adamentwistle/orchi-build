#!/usr/bin/env python3
"""Builds themes/orchi-dark.json and themes/orchi-light.json from the palette below, and prints their contrast.

Usage: scripts/build-themes.py
Every colour is written as OKLCH (lightness 0 to 1, chroma, hue in degrees) and turned into sRGB hex here. A colour
outside sRGB keeps its lightness and hue and loses chroma until it fits.
"""
import json, math, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = f'{ROOT}/themes'

def to_srgb(l, c, h):
    a, b = c*math.cos(math.radians(h)), c*math.sin(math.radians(h))
    lms = ((l+0.3963377774*a+0.2158037573*b)**3, (l-0.1055613458*a-0.0638541728*b)**3, (l-0.0894841775*a-1.2914855480*b)**3)
    x, y, z = lms
    return (4.0767416621*x-3.3077115913*y+0.2309699292*z,
            -1.2684380046*x+2.6097574011*y-0.3413193965*z,
            -0.0041960863*x-0.7034186147*y+1.7076147010*z)

def ok(l, c=0.0, h=0.0):
    while True:
        lin = to_srgb(l, c, h)
        if all(-1e-6 <= v <= 1+1e-6 for v in lin) or c <= 0:
            break
        c = max(0.0, c-0.002)
    f = lambda v: 12.92*v if v <= 0.0031308 else 1.055*v**(1/2.4)-0.055
    return '#%02x%02x%02x' % tuple(round(max(0, min(1, f(max(0, v))))*255) for v in lin)

def lum(hx):
    g = lambda c: c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
    r, gr, b = (int(hx[i:i+2], 16)/255 for i in (1, 3, 5))
    return 0.2126*g(r)+0.7152*g(gr)+0.0722*g(b)

def contrast(a, b):
    x, y = sorted((lum(a), lum(b)), reverse=True)
    return (x+0.05)/(y+0.05)

# Hues. Neutrals lean slightly cool and violet; the accent is a soft violet.
N, ACCENT, RED, YELLOW, GREEN, CYAN, BLUE, MAGENTA = 275, 296, 24, 84, 150, 205, 254, 330

def grey(l, c=0.007): return ok(l, c, N)

dark_ink = grey(0.962, 0.004)
dark = {
  'background': grey(0.286), 'foreground': dark_ink, 'selection': grey(0.418, 0.012), 'cursor': dark_ink,
  'ansi': [grey(0.405), ok(0.745, 0.15, RED), ok(0.83, 0.17, GREEN), ok(0.855, 0.15, YELLOW),
           ok(0.765, 0.12, BLUE), ok(0.775, 0.125, MAGENTA), ok(0.85, 0.11, CYAN), grey(0.835, 0.005),
           grey(0.705), ok(0.835, 0.11, RED), ok(0.895, 0.15, GREEN), ok(0.915, 0.12, YELLOW),
           ok(0.86, 0.08, BLUE), ok(0.865, 0.085, MAGENTA), ok(0.915, 0.08, CYAN), grey(0.985, 0.002)],
  'colors': {
    'canvas': grey(0.226), 'chrome': grey(0.226), 'surface': grey(0.286), 'popover': grey(0.382, 0.010),
    'raised': grey(0.328), 'hover': '#ffffff10', 'selected': '#ffffff22', 'selection': ok(0.795, 0.105, ACCENT)+'55',
    'border': '#ffffff16', 'input': '#ffffff16',
    'muted': grey(0.805, 0.012), 'dim': grey(0.715, 0.010),
    'accent': ok(0.795, 0.105, ACCENT), 'accent_foreground': grey(0.185, 0.012),
    'solid': grey(0.955, 0.004), 'solid_foreground': grey(0.185, 0.012),
    'working': ok(0.705, 0.15, BLUE), 'blocked': ok(0.685, 0.19, RED), 'done': ok(0.82, 0.175, GREEN),
    'idle': grey(0.715, 0.010), 'unknown': grey(0.715, 0.010),
  },
}

light_ink = grey(0.255, 0.014)
light = {
  'background': '#ffffff', 'foreground': light_ink, 'selection': grey(0.935, 0.010), 'cursor': light_ink,
  'ansi': [grey(0.265, 0.012), ok(0.53, 0.19, RED), ok(0.52, 0.14, GREEN), ok(0.56, 0.13, YELLOW),
           ok(0.53, 0.17, BLUE), ok(0.52, 0.19, MAGENTA), ok(0.54, 0.10, CYAN), grey(0.56),
           grey(0.50), ok(0.47, 0.17, RED), ok(0.46, 0.12, GREEN), ok(0.50, 0.11, YELLOW),
           ok(0.47, 0.15, BLUE), ok(0.46, 0.17, MAGENTA), ok(0.48, 0.09, CYAN), grey(0.20, 0.012)],
  'colors': {
    'canvas': grey(0.977, 0.004), 'chrome': grey(0.977, 0.004), 'surface': '#ffffff', 'popover': '#ffffff',
    'raised': grey(0.955, 0.005), 'hover': light_ink+'10', 'selected': light_ink+'1e', 'selection': ok(0.53, 0.19, ACCENT)+'55',
    'border': grey(0.905, 0.006), 'input': grey(0.905, 0.006),
    'muted': grey(0.455, 0.014), 'dim': grey(0.535, 0.012),
    'accent': ok(0.53, 0.19, ACCENT), 'accent_foreground': '#ffffff',
    'solid': light_ink, 'solid_foreground': '#ffffff',
    'working': ok(0.545, 0.18, BLUE), 'blocked': ok(0.535, 0.195, RED), 'done': ok(0.515, 0.14, GREEN),
    'idle': grey(0.535, 0.012), 'unknown': grey(0.535, 0.012),
  },
}

if __name__ == '__main__':
    for name, th in (('orchi-dark', dark), ('orchi-light', light)):
        with open(f'{OUT}/{name}.json', 'w') as f:
            json.dump(th, f, indent=2)
            f.write('\n')
        bg, co = th['background'], th['colors']
        ch = co['chrome']
        print(f'{name}: bg {bg} chrome {ch} accent {co["accent"]} border {co["border"]}')
        for i, c in enumerate(th['ansi']):
            if i in (0, 15) if name.endswith('light') else i == 0:
                continue
            r = contrast(c, bg)
            print(f'  ansi{i:<2} {c} {r:5.2f}', 'LOW' if r < 4.5 else '')
        for k in ('muted', 'dim', 'accent', 'working', 'blocked', 'done', 'idle'):
            for g in (ch, bg):
                r = contrast(co[k], g)
                print(f'  {k:8} on {g} {r:5.2f}', 'LOW' if r < 4.5 else '')
        print(f'  accent_foreground on accent {contrast(co["accent_foreground"], co["accent"]):.2f};'
              f' solid pair {contrast(co["solid"], co["solid_foreground"]):.2f};'
              f' foreground on selection {contrast(th["foreground"], th["selection"]):.2f}')
