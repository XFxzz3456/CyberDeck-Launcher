# -*- coding: utf-8 -*-
"""把项目 Markdown 文档拆成：无表格骨架 + 每张 GFM 表格的 <Table> 组件分段 XML。

用法: python md_to_doc_tables.py <input.md> <output_dir>
产出:
  <output_dir>/skeleton.md      表格替换为 [[NC-TABLE-PLACEHOLDER-N]] 占位段
  <output_dir>/manifest.json    表格清单与分段文件列表
  <output_dir>/tNNN_segK.xml    每段完整 <Table>（≤10 行 / ≤3200 字节，含表头）
"""
import io, json, os, re, sys

def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def clean_inline(s: str) -> str:
    # 去掉 Markdown 内联标记，保留纯文本（单元格内不做 Mark/Link，保平安）
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"\[([^\]]*)\]\(([^)]*)\)", r"\1（\2）", s)
    s = s.replace("**", "").replace("__", "").replace("`", "")
    s = s.replace("\\|", "|")
    return s.strip()

def split_row(line: str):
    t = line.strip()
    if t.startswith("|"):
        t = t[1:]
    if t.endswith("|"):
        t = t[:-1]
    return [clean_inline(c) for c in t.split("|")]

def is_table_line(line: str) -> bool:
    t = line.strip()
    return t.startswith("|") and t.count("|") >= 2

def is_sep_row(cells) -> bool:
    return all(re.fullmatch(r":?-{2,}:?", c.strip()) or c.strip() == "" for c in cells) and any(c.strip() for c in cells)

def table_xml(rows):
    out = ["<Table>"]
    for row in rows:
        out.append("    <TableRow>")
        # 列数对齐：不足补空，超出截断
        for cell in row:
            out.append("        <TableCell>")
            out.append(f"            <Paragraph>{esc(cell)}</Paragraph>" if cell else "            <Paragraph></Paragraph>")
            out.append("        </TableCell>")
        out.append("    <TableRow>".replace("<TableRow>", "</TableRow>"))
    out.append("</Table>")
    return "\n".join(out)

def main():
    src, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    lines = io.open(src, encoding="utf-8").read().splitlines()
    skeleton, manifest = [], {"tables": []}
    i, n, tidx = 0, len(lines), 0
    while i < n:
        line = lines[i]
        if is_table_line(line) and i + 1 < n and is_table_line(lines[i + 1]):
            rows = []
            j = i
            while j < n and is_table_line(lines[j]):
                rows.append(split_row(lines[j]))
                j += 1
            # 丢掉分隔行
            rows = [r for r in rows if not is_sep_row(r)]
            ncols = max(len(r) for r in rows)
            rows = [r + [""] * (ncols - len(r)) for r in rows]
            tidx += 1
            name = f"t{tidx:03d}"
            caption = clean_inline(rows[0][0])[:40] if rows and rows[0] else name
            # 分段：每段含表头，≤10 行且 ≤3200 字节
            segs, k = [], 0
            while k < len(rows):
                take = min(10, len(rows) - k)
                head = [] if k == 0 else [rows[0]]
                blob = table_xml(head + rows[k:k + take])
                while take > 1 and len(blob.encode("utf-8")) > 3200:
                    take -= 1
                    head = [] if k == 0 else [rows[0]]
                    blob = table_xml(head + rows[k:k + take])
                k += take
                seg_idx = len(segs) + 1
                fn = f"{name}_seg{seg_idx}.xml"
                io.open(os.path.join(outdir, fn), "w", encoding="utf-8", newline="\n").write(blob)
                segs.append(fn)
            skeleton.append(f"[[NC-TABLE-PLACEHOLDER-{tidx}:{caption}]]")
            skeleton.append("")
            manifest["tables"].append({"index": tidx, "caption": caption,
                                       "rows": len(rows), "cols": ncols, "segments": segs})
            i = j
            continue
        skeleton.append(line)
        i += 1
    io.open(os.path.join(outdir, "skeleton.md"), "w", encoding="utf-8", newline="\n").write("\n".join(skeleton) + "\n")
    io.open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8", newline="\n").write(
        json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"tables={tidx} segs={sum(len(t['segments']) for t in manifest['tables'])}")

if __name__ == "__main__":
    main()
