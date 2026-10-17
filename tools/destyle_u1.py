#!/usr/bin/env python3
"""U1 kolo 4: replace inline style="" by token utility classes (vt_panel.css).
Usage: destyle.py FILE [start_marker end_marker]  -> rewrites FILE in place,
prints unknown declarations (kept inline). display:none is state -> kept."""
import re, sys

def px(v):
    m = re.match(r'^(-?[\d.]+)px$', v.strip()); return float(m.group(1)) if m else None

def classes_for(style):
    decls = [d.strip() for d in style.split(';') if d.strip()]
    d = {}
    for x in decls:
        if ':' not in x: return None, style
        k, v = x.split(':', 1); d[k.strip().lower()] = v.strip()
    cls, keep = [], []
    used = set()
    def use(*ks): used.update(ks)
    # composite patterns first
    if d.get('height') == '22px' and 'width' in d:
        cls.append('vt-color'); use('width','height','padding','background','border')
    if 'background' in d and 'linear-gradient(90deg' in d['background']:
        cls.append('vt-sw-terrain'); use('background','color')
    if d.get('border-top','').startswith('1px dashed'):
        cls.append('vt-sep-dashed'); use('border-top','padding-top')
    if d.get('border-bottom','').startswith('1px solid') and 'position' not in d:
        cls.append('vt-sep'); use('border-bottom','padding')
    if ('border-radius' in d and ('background' in d or 'border' in d)) and 'position' not in d:
        cls.append('vt-box'); use('border','border-radius','padding','background')
    if d.get('position') == 'sticky' or ('linear-gradient(var(--bs-gray-900)' in d.get('background','')):
        use(*d.keys())   # legacy editor chrome: hidden in the drawer, styled by class
        if 'display' in d and d['display']=='none': keep.append('display: none')
        used.discard('display')
    for k, v in d.items():
        if k in used: continue
        vv = v.replace(' ', '')
        if k == 'display':
            if vv == 'none': keep.append('display: none')
            elif vv == 'block': cls.append('vt-block')
            elif vv == 'flex': cls.append('vt-flex')
            elif vv in ('inline', 'inline-flex', 'inline-block'): cls.append('vt-inline')
            else: keep.append(k+': '+v)
        elif k == 'font-size':
            n = px(v)
            if n is None: keep.append(k+': '+v)
            elif n <= 11: cls.append('vt-fs-xs')
            elif n < 13: cls.append('vt-fs-sm')
            elif n < 14: cls.append('vt-fs-md')
            elif n <= 15: cls.append('vt-fs-lg')
            else: cls.append('vt-fs-xl')
        elif k == 'opacity':
            try: o = float(v)
            except ValueError: keep.append(k+': '+v); continue
            cls.append('vt-dim' if o < .95 else '')
        elif k in ('margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding-top', 'padding-left', 'padding-right', 'padding-bottom'):
            n = px(v); side = {'margin-top':'mt','margin-bottom':'mb','margin-left':'ml','margin-right':'mr','padding-top':'pt','padding-left':'pl','padding-right':'pr','padding-bottom':'pb'}[k]
            if n is None and v.strip() == '0': n = 0
            if n is None: keep.append(k+': '+v); continue
            cls.append('vt-%s%d' % (side, 0 if n == 0 else (1 if n <= 4 else (2 if n <= 10 else 3))))
        elif k == 'margin':
            p = v.split()
            pp = [px(x) if x != '0' else 0 for x in p]
            if None in pp: keep.append(k+': '+v); continue
            if len(pp) == 1: pp = pp*4
            if len(pp) == 2: pp = [pp[0], pp[1], pp[0], pp[1]]
            if len(pp) == 3: pp = [pp[0], pp[1], pp[2], pp[1]]
            for side, n in zip(('mt','mr','mb','ml'), pp):
                if n: cls.append('vt-%s%d' % (side, 1 if n <= 4 else (2 if n <= 10 else 3)))
                else: cls.append('vt-%s0' % side)
        elif k == 'padding':
            p = v.split(); pp = [px(x) if x != '0' else 0 for x in p]
            if None in pp: keep.append(k+': '+v); continue
            cls.append('vt-pad-s' if max(pp) <= 10 else 'vt-pad-m')
        elif k == 'width':
            if vv == '100%': cls.append('vt-w100'); continue
            n = px(v)
            if n is None or n > 300: continue          # page-era fixed widths: the drawer decides
            cls.append('vt-w-xs' if n <= 50 else ('vt-w-sm' if n <= 100 else ('vt-w-md' if n <= 130 else 'vt-w-lg')))
        elif k in ('max-width', 'min-height', 'height', 'max-height', 'overflow', 'line-height', 'z-index', 'border-color', 'cursor'):
            if k == 'min-height' and (px(v) or 0) < 20: cls.append('vt-minh-line')
            elif k == 'line-height' and vv == '1': cls.append('vt-lh1')
            elif k == 'cursor' and vv == 'pointer': cls.append('vt-pointer')
            # other sizes: tokens / touch rules decide
        elif k == 'gap': cls.append('vt-gap6')
        elif k == 'flex-wrap': cls.append('vt-wrap' if vv == 'wrap' else 'vt-nowrap')
        elif k == 'align-items': cls.append({'center':'vt-aic','end':'vt-aie','flex-end':'vt-aie'}.get(vv,''))
        elif k == 'flex': cls.append('vt-grow1' if vv.startswith('11') else ('vt-none' if vv == '00auto' else ''))
        elif k == 'min-width' and vv == '0': cls.append('vt-min0')
        elif k == 'color':
            if 'gray' in vv or vv in ('#9aa0a6', '#ccc'): cls.append('vt-muted')
            elif 'info' in vv or vv in ('#0dcaf0',): cls.append('vt-accent')
            elif vv.startswith('#'): cls.append('vt-sw-' + vv[1:].lower())
            elif vv == 'transparent': pass
            else: keep.append(k+': '+v)
        elif k == 'text-align': cls.append('vt-tar' if vv == 'right' else ('vt-tac' if vv == 'center' else ''))
        elif k == 'float': cls.append('vt-fr' if vv == 'right' else '')
        elif k == 'font-weight': cls.append('vt-strong')
        elif k == 'vertical-align': cls.append('vt-vam')
        elif k == 'letter-spacing': cls.append('vt-ls')
        elif k == 'text-transform': cls.append('vt-caps')
        elif k == 'white-space': cls.append('vt-pre' if 'pre' in vv else 'vt-nowrap-text')
        elif k == 'overflow-wrap': cls.append('vt-wrap-any')
        elif k == 'border-top-style' or k == 'border-right-style' or k == 'border-left-style': pass
        else: keep.append(k+': '+v)
    cls = [c for c in dict.fromkeys(cls) if c]
    return cls, '; '.join(keep)

ATTR = re.compile(r'<(\w+)((?:[^>"\']|"[^"]*"|\'[^\']*\')*?)\s+style="([^"]*)"')
def convert(text, unknown):
    def fix(m):
        tag, attrs, style = m.group(1), m.group(2), m.group(3)
        if "'" in style or '${' in style:          # dynamic JS style: leave for a hand edit
            unknown.append('DYN ' + style[:80]); return m.group(0)
        cls, keep = classes_for(style)
        if cls is None: unknown.append('BAD ' + style); return m.group(0)
        if keep and keep != 'display: none': unknown.append(keep)
        if cls:
            cm = re.search(r'\bclass="([^"]*)"', attrs)
            if cm: attrs = attrs[:cm.start()] + 'class="%s %s"' % (cm.group(1), ' '.join(cls)) + attrs[cm.end():]
            else: attrs = attrs + ' class="%s"' % ' '.join(cls)
        st = (' style="%s;"' % keep) if keep else ''
        return '<%s%s%s' % (tag, attrs, st)
    return ATTR.sub(fix, text)

if __name__ == '__main__':
    f = sys.argv[1]; s = open(f, encoding='utf-8').read()
    unknown = []
    if len(sys.argv) > 3:
        a = s.index(sys.argv[2]); b = s.index(sys.argv[3], a)
        s = s[:a] + convert(s[a:b], unknown) + s[b:]
    else:
        s = convert(s, unknown)
    open(f, 'w', encoding='utf-8').write(s)
    from collections import Counter
    for k, v in Counter(unknown).most_common(): print(v, k)
