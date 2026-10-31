"""一次性迁移：把「作为文字色」的强调色切换到 --accent-text 令牌。

只改 `color:` 属性（含 -webkit-text-fill-color），不碰 background / border-color，
因此强调色作为填充时仍然是原色，作为文字时可以在浅色主题下自动压深。
"""
import re

PATH = "src/styles.css"
src = open(PATH, encoding="utf-8").read()

pat1 = re.compile(r"(?<![\w-])color:\s*var\(--(?:yellow|accent)\)")
n1 = len(pat1.findall(src))
src = pat1.sub("color: var(--accent-text)", src)

pat2 = re.compile(r"(?<![\w-])color:\s*rgba\(var\(--accent-rgb\),")
n2 = len(pat2.findall(src))
src = pat2.sub("color: rgba(var(--accent-text-rgb),", src)

pat3 = re.compile(r"(-webkit-text-fill-color:\s*)var\(--(?:yellow|accent)\)")
n3 = len(pat3.findall(src))
src = pat3.sub(r"\1var(--accent-text)", src)

open(PATH, "w", encoding="utf-8", newline="").write(src)
print("color: var(--yellow|accent)      ->", n1)
print("color: rgba(var(--accent-rgb)    ->", n2)
print("-webkit-text-fill-color          ->", n3)
print("remaining color: var(--yellow)   =", len(re.findall(r"(?<![\w-])color:\s*var\(--yellow", src)))
print("accent-text refs total           =", src.count("--accent-text"))
