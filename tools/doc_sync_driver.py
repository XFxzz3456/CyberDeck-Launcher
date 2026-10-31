# -*- coding: utf-8 -*-
"""把转换好的表格分段插回被覆盖的文档：
占位段后插 seg1 → 回读拿新表 block id 链 seg2..N → 删占位段 → 最终校验无占位。
用法: python doc_sync_driver.py <page_id> <tables_dir>
"""
import io, json, os, re, subprocess, sys, tempfile

SKILL = "D:/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/library/doc"

def run(args):
    p = subprocess.run(["python"] + args, capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0 and not p.stdout.strip():
        raise RuntimeError("script failed: " + (p.stderr or "")[:300])
    return p.stdout

def read_back(page_id):
    out = run([f"{SKILL}/get_doc_reviews.py", "--page-id", page_id])
    if out.strip().startswith('{"error"') or not out.strip():
        raise RuntimeError("read back failed: " + out[:200])
    return out

def submit(page_id, actions):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(actions, f, ensure_ascii=False)
        path = f.name
    out = run([f"{SKILL}/submit_doc_edit.py", "--page-id", page_id, "--actions-file", path])
    os.unlink(path)
    if "KS_DOC_EDIT_SUBMIT" not in out:
        raise RuntimeError("submit failed: " + out[:400])
    return out

def find_placeholders(content):
    return {int(m.group(2)): m.group(1)
            for m in re.finditer(r'<Paragraph id="([^"]+)">\s*\\\[\\\[\s*NC-TABLE-PLACEHOLDER-(\d+)', content)}

def find_table_after(content, block_id):
    idx = content.find(block_id)
    if idx < 0:
        raise RuntimeError(f"anchor {block_id} not found in read-back")
    m = re.search(r'<Table id="([^"]+)"', content[idx + len(block_id):])
    return m.group(1) if m else None

def main():
    page_id, tables_dir = sys.argv[1], sys.argv[2]
    manifest = json.load(io.open(os.path.join(tables_dir, "manifest.json"), encoding="utf-8"))
    content = read_back(page_id)
    placeholders = find_placeholders(content)
    print("placeholders:", placeholders)
    for t in manifest["tables"]:
        ph_id = placeholders.get(t["index"])
        if not ph_id:
            raise RuntimeError(f"placeholder {t['index']} not found")
        anchor = ph_id
        for seg in t["segments"]:
            xml = io.open(os.path.join(tables_dir, seg), encoding="utf-8").read().strip()
            submit(page_id, [{"type": "insert_after", "id": anchor, "content": xml}])
            content = read_back(page_id)
            new_id = find_table_after(content, anchor)
            if not new_id:
                raise RuntimeError(f"inserted table after {anchor} ({seg}) not found in read-back")
            print(f"table {t['index']} {seg}: {new_id}")
            anchor = new_id
        submit(page_id, [{"type": "delete", "id": ph_id}])
        print(f"table {t['index']} done, placeholder removed")
    content = read_back(page_id)
    left = find_placeholders(content)
    print("DONE. placeholders remaining:", left)
    sys.exit(1 if left else 0)

if __name__ == "__main__":
    main()
